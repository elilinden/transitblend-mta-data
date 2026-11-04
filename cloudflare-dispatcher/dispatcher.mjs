// Timer/metadata monitor only. Never downloads or processes the MTA index.
const OWNER_REPO = 'elilinden/transitblend-mta-data';
const WORKFLOW = '407309899';
export const CRON = '11,41 * * * *';
export const RUNS_URL = `https://api.github.com/repos/${OWNER_REPO}/actions/workflows/${WORKFLOW}/runs?branch=main&per_page=5`;
export const DISPATCH_URL = `https://api.github.com/repos/${OWNER_REPO}/actions/workflows/${WORKFLOW}/dispatches`;
export const MANIFEST_URL = `https://github.com/${OWNER_REPO}/releases/latest/download/manifest.json`;
const SOURCE = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip';
const MINUTE = 60_000;
const FRESHNESS = 120 * MINUTE; // Must agree with the backend; never renew retained evidence.

class Failure extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
const epoch = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  // Date.parse can normalize an invalid date instead of rejecting it.
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value.slice(0, 10) ? parsed : NaN;
};
const positive = value => Number.isSafeInteger(value) && value > 0;

async function smallJson(response, maxBytes) {
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes || !response.body) throw new Failure('invalid_response');
  const reader = response.body.getReader();
  const parts = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Failure('oversized_response');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Failure('invalid_response'); }
}

function apiFailure(response) {
  const status = response.status;
  if (status === 401) return new Failure('authentication_failed', status);
  if (status === 429 || status === 403 && response.headers.get('x-ratelimit-remaining') === '0') return new Failure('rate_limited', status);
  if (status === 403) return new Failure('permission_denied', status);
  if (status === 404) return new Failure('workflow_inaccessible', status);
  return new Failure('github_api_failed', status);
}

function manifestMetadata(value, now) {
  const generated = epoch(value?.generatedAt), attempted = epoch(value?.refresh?.attemptedAt), last = epoch(value?.refresh?.lastSuccessfulAt);
  const index = value?.index;
  const hash = typeof index?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(index.sha256) ? index.sha256 : undefined;
  const sourceTime = value?.sourceUpdatedAt === undefined ? undefined : epoch(value.sourceUpdatedAt);
  let url;
  try { url = new URL(index.url); } catch { /* invalid metadata */ }
  if (value?.version !== 1 || value.source !== SOURCE || !Number.isInteger(value.tripCount) || value.tripCount < 1000 || value.tripCount > 150000
    || !hash || !positive(index.bytes) || index.bytes > 20000000 || !url || url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.search || url.hash
    || !new RegExp(`^/${OWNER_REPO}/releases/download/mta-schedule-[\\w.-]+/schedule-index-${hash}\\.json\\.gz$`).test(url.pathname)
    || !['success','failed'].includes(value.refresh?.status) || ![generated, attempted, last].every(Number.isFinite)
    || generated > now + MINUTE || attempted > now + MINUTE || last > attempted || generated > last + MINUTE
    || sourceTime !== undefined && (!Number.isFinite(sourceTime) || sourceTime > now + MINUTE)) throw new Failure('invalid_manifest');
  const age = Math.max(0, now - generated);
  return {
    // Metadata only: this Worker does NOT verify gzip bytes/native trip identity.
    state: age > FRESHNESS || sourceTime !== undefined && now-sourceTime > FRESHNESS ? 'stale'
      : value.refresh.status === 'failed' ? 'retained_after_failed_refresh' : 'fresh_metadata',
    ageSeconds: Math.floor(age / 1000), generatedAt: value.generatedAt, lastSuccessfulAt: value.refresh.lastSuccessfulAt,
    refreshStatus: value.refresh.status, ...(sourceTime === undefined ? {} : { sourceUpdatedAt: value.sourceUpdatedAt }),
  };
}

/** Dependencies are injected only for offline tests, never accepted from HTTP or env URLs. */
export function createDispatcher({ fetcher = fetch, now = Date.now, logger = console, timeoutMs = 10_000 } = {}) {
  const seen = new Map();
  let inFlight;

  async function bounded(url, options, maxBytes, kind) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetcher(url, { ...options, signal: abort.signal });
      if (kind === 'github' && !response.ok) { await response.body?.cancel().catch(() => {}); throw apiFailure(response); }
      return { response, body: response.status === 204 ? undefined : await smallJson(response, maxBytes) };
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw new Failure(abort.signal.aborted ? 'timeout' : 'network_failed'); // Never log raw errors/bodies.
    } finally { clearTimeout(timer); }
  }

  async function metadata() {
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      let url = MANIFEST_URL;
      for (let hop = 0; hop < 4; hop++) {
        // No Authorization header is ever sent to public asset/redirect hosts.
        const response = await fetcher(url, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }, redirect: 'manual', signal: abort.signal });
        if ([301,302,303,307,308].includes(response.status)) {
          const target = new URL(response.headers.get('location'), url);
          await response.body?.cancel().catch(() => {});
          // /latest/download first redirects to this repository's immutable release URL.
          const sameManifest = target.hostname === 'github.com' && !target.search && !target.hash
            && new RegExp(`^/${OWNER_REPO}/releases/download/mta-schedule-[\\w.-]+/manifest\\.json$`).test(target.pathname);
          if (target.protocol !== 'https:' || target.port || target.username || target.password
            || !sameManifest && !['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(target.hostname)) throw new Failure('invalid_manifest_redirect');
          url = target.href; continue;
        }
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Failure('manifest_unavailable', response.status); }
        return manifestMetadata(await smallJson(response, 8192), now());
      }
      throw new Failure('invalid_manifest_redirect');
    } catch (error) {
      return { state: error instanceof Failure ? error.code : abort.signal.aborted ? 'manifest_timeout' : 'manifest_unavailable' };
    } finally { clearTimeout(timer); }
  }

  function emit(result) {
    if (result.publication?.generatedAt) {
      const age = Math.max(0, now() - epoch(result.publication.generatedAt));
      const sourceAge = result.publication.sourceUpdatedAt === undefined ? 0 : now() - epoch(result.publication.sourceUpdatedAt);
      result = { ...result, publication: { ...result.publication, ageSeconds: Math.floor(age / 1000),
        ...(age > FRESHNESS || sourceAge > FRESHNESS ? { state: 'stale' } : {}) } };
    }
    if (result.scheduledFor && result.outcome !== 'skip_duplicate_slot') seen.set(Math.floor(epoch(result.scheduledFor) / (30 * MINUTE)), result);
    const unhealthy = !result.ok || result.publication && result.publication.state !== 'fresh_metadata';
    const approachingExpiry = result.publication?.state === 'fresh_metadata' && result.publication.ageSeconds >= 90 * 60;
    logger[unhealthy || approachingExpiry ? 'error' : 'info'](JSON.stringify({ event: 'mta_schedule_dispatcher', ...result,
      ...(approachingExpiry ? { publicationWarning: 'approaching_expiry' } : {}) }));
    return result;
  }

  async function execute(controller, env) {
    const scheduled = controller?.scheduledTime;
    // A delayed timer can still acquire CURRENT data. Do not reject a useful
    // 20-minute-late invocation; dedupe against actual runs/publications below.
    if (controller?.cron !== CRON || !Number.isSafeInteger(scheduled) || scheduled > now() + MINUTE || now() - scheduled > FRESHNESS) {
      return emit({ ok: false, outcome: 'invalid_or_old_trigger' });
    }
    const scheduledFor = new Date(scheduled).toISOString();
    // Best-effort per-isolate guard, not a distributed exactly-once promise.
    const slot = Math.floor(scheduled / (30 * MINUTE));
    if (seen.has(slot)) {
      const prior = seen.get(slot);
      return emit({ ok: prior.ok === true, outcome: 'skip_duplicate_slot', scheduledFor, previousOutcome: prior.outcome,
        ...(prior.publication ? { publication: prior.publication } : {}), dispatchMayHaveOccurred: prior.dispatchMayHaveOccurred === true });
    }
    seen.set(slot, { ok: false, outcome: 'in_progress' });
    while (seen.size > 8) seen.delete(seen.keys().next().value);
    const token = env?.GH_ACTIONS_TOKEN;
    if (typeof token !== 'string' || token.length < 20 || /\s/.test(token)) return emit({ ok: false, outcome: 'missing_secret', scheduledFor });
    const headers = { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'TransitBlend-MTA-Refresh', Authorization: `Bearer ${token}` };
    let publication;
    let dispatchAttempted = false;
    try {
      const { body } = await bounded(RUNS_URL, { method: 'GET', headers, redirect: 'error' }, 131072, 'github');
      if (!Array.isArray(body?.workflow_runs) || body.workflow_runs.length > 5) throw new Failure('invalid_run_list');
      const runs = body.workflow_runs;
      if (runs.some(r => !positive(r.id) || r.head_branch !== 'main' || !Number.isFinite(epoch(r.created_at)) || epoch(r.created_at) > now()+MINUTE
        || !['completed','in_progress','queued','requested','waiting','pending'].includes(r.status))) throw new Failure('invalid_run_list');
      publication = await metadata();
      if (runs.some(r => r.status !== 'completed')) return emit({ ok: true, outcome: 'skip_active_run', scheduledFor, publication });
      // A timeout/redelivery must not immediately create another run, including after a failed run.
      if (runs.some(r => now() - epoch(r.created_at) < 10 * MINUTE)) return emit({ ok: true, outcome: 'skip_recent_run', scheduledFor, publication });
      if (publication.state === 'fresh_metadata' && publication.ageSeconds < 25 * 60) return emit({ ok: true, outcome: 'skip_recent_publication', scheduledFor, publication });
      dispatchAttempted = true;
      const { response, body: accepted } = await bounded(DISPATCH_URL, { method: 'POST', headers, body: JSON.stringify({ ref: 'main' }), redirect: 'error' }, 4096, 'github');
      if (response.status !== 200 || !positive(accepted?.workflow_run_id)) throw new Failure('dispatch_accepted_unconfirmed', response.status);
      return emit({ ok: true, outcome: 'dispatch_accepted', scheduledFor, workflowRunId: accepted.workflow_run_id, publication,
        completion: 'not_checked', validatedPublication: 'not_checked' });
    } catch (error) {
      const known = error instanceof Failure ? error : new Failure('internal_failure');
      return emit({ ok: false, outcome: known.code, ...(known.status ? { httpStatus: known.status } : {}), scheduledFor,
        ...(publication ? { publication } : {}), dispatchAttempted,
        // Acceptance can precede a timeout, disconnect, error response or unreadable response.
        dispatchMayHaveOccurred: dispatchAttempted && !['authentication_failed','permission_denied','rate_limited','workflow_inaccessible'].includes(known.code) });
    }
  }

  return function run(controller, env) {
    if (inFlight) return inFlight;
    inFlight = execute(controller, env).finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
