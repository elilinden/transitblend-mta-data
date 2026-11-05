import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from './worker.mjs';
import { createDispatcher, CRON, RUNS_URL, DISPATCH_URL, MANIFEST_URL } from './dispatcher.mjs';

const NOW = Date.parse('2026-11-04T22:41:00Z');
const TOKEN = 'fixture-only-secret-never-a-real-credential';
const env = { GH_ACTIONS_TOKEN: TOKEN };
const controller = { cron: CRON, scheduledTime: NOW };
const iso = minutes => new Date(NOW - minutes * 60000).toISOString();
const manifest = (minutes = 121) => ({ version: 1, source: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip',
  generatedAt: iso(minutes), tripCount: 55570,
  index: { url: `https://github.com/elilinden/transitblend-mta-data/releases/download/mta-schedule-fixture/schedule-index-${'a'.repeat(64)}.json.gz`, sha256: 'a'.repeat(64), bytes: 8544053 },
  refresh: { status: 'success', attemptedAt: iso(minutes), lastSuccessfulAt: iso(minutes) } });
const run = (status = 'completed', minutes = 31) => ({ id: 9, head_branch: 'main', created_at: iso(minutes), status });
function fixture({ runs = [run()], publication = manifest(), respond, timeoutMs } = {}) {
  const calls = [], logs = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (respond) { const result = await respond(url, options); if (result !== undefined) return result; }
    if (url === RUNS_URL) return Response.json({ workflow_runs: runs });
    if (url === MANIFEST_URL) return Response.json(publication);
    if (url === DISPATCH_URL) return Response.json({ workflow_run_id: 123, run_url: 'not-used', html_url: 'not-used' });
    throw Error('Unexpected URL in offline test');
  };
  const dispatcher = createDispatcher({ fetcher, now: () => NOW, timeoutMs, logger: {
    info: line => logs.push({ level: 'info', ...JSON.parse(line) }), error: line => logs.push({ level: 'error', ...JSON.parse(line) }),
  } });
  return { dispatcher, calls, logs, posts: () => calls.filter(c => c.options.method === 'POST') };
}

test('dispatch acceptance is separate from validated publication; stale metadata stays stale', async () => {
  const f = fixture(); const result = await f.dispatcher(controller, env);
  assert.equal(result.outcome, 'dispatch_accepted'); assert.equal(result.workflowRunId, 123);
  assert.equal(result.publication.state, 'stale'); assert.equal(result.completion, 'not_checked');
  assert.equal(result.validatedPublication, 'not_checked'); assert.equal(f.posts().length, 1);
  assert.deepEqual(JSON.parse(f.posts()[0].options.body), { ref: 'main' });
  assert.equal(f.logs[0].level, 'error');
});
test('no token means no network call', async () => {
  const f = fixture(); assert.equal((await f.dispatcher(controller, {})).outcome, 'missing_secret'); assert.equal(f.calls.length, 0);
});
for (const [status, code] of [[401,'authentication_failed'],[403,'permission_denied'],[404,'workflow_inaccessible'],[429,'rate_limited'],[503,'github_api_failed']]) {
  test(`GitHub ${status} fails closed without retry or raw body logging`, async () => {
    const f = fixture({ respond: url => url === RUNS_URL ? new Response('provider-body-' + TOKEN, { status }) : undefined });
    const result = await f.dispatcher(controller, env);
    assert.equal(result.outcome, code); assert.equal(result.httpStatus, status); assert.equal(f.calls.length, 1); assert.equal(f.posts().length, 0);
    assert.ok(!JSON.stringify(f.logs).includes(TOKEN)); assert.ok(!JSON.stringify(f.logs).includes('provider-body'));
  });
}
test('GitHub secondary/primary rate limit never causes an immediate retry', async () => {
  const f = fixture({ respond: url => url === RUNS_URL ? new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '60' } }) : undefined });
  assert.equal((await f.dispatcher(controller, env)).outcome, 'rate_limited'); assert.equal(f.calls.length, 1);
});
test('expired/rejected token at dispatch is an authentication failure, not success', async () => {
  const f = fixture({ respond: url => url === DISPATCH_URL ? new Response(TOKEN, { status: 401 }) : undefined });
  const result = await f.dispatcher(controller, env);
  assert.equal(result.outcome, 'authentication_failed'); assert.equal(result.dispatchMayHaveOccurred, false); assert.equal(f.posts().length, 1);
  assert.ok(!JSON.stringify(f.logs).includes(TOKEN));
});
test('authentication read timeout is bounded and makes no POST', async () => {
  const f = fixture({ timeoutMs: 5, respond: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error(TOKEN)))) });
  assert.equal((await f.dispatcher(controller, env)).outcome, 'timeout'); assert.equal(f.posts().length, 0);
  assert.ok(!JSON.stringify(f.logs).includes(TOKEN));
});
test('dispatch timeout is ambiguous and not retried on redelivery in the same isolate', async () => {
  const f = fixture({ timeoutMs: 5, respond: (url, options) => url === DISPATCH_URL
    ? new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('timed out ' + TOKEN)))) : undefined });
  const result = await f.dispatcher(controller, env);
  assert.equal(result.outcome, 'timeout'); assert.equal(result.dispatchMayHaveOccurred, true);
  const redelivery = await f.dispatcher(controller, env);
  assert.equal(redelivery.outcome, 'skip_duplicate_slot'); assert.equal(redelivery.ok, false);
  assert.equal(redelivery.previousOutcome, 'timeout'); assert.equal(redelivery.dispatchMayHaveOccurred, true); assert.equal(f.posts().length, 1);
});
test('malformed/204 dispatch responses never imply a completed refresh and are not retried', async () => {
  for (const response of [new Response(null, { status: 204 }), Response.json({}), new Response('not json')]) {
    const f = fixture({ respond: url => url === DISPATCH_URL ? response : undefined });
    const result = await f.dispatcher(controller, env);
    assert.equal(result.ok, false); assert.equal(result.dispatchMayHaveOccurred, true); assert.equal(f.posts().length, 1);
    assert.equal(result.validatedPublication, undefined);
  }
});
for (const status of ['in_progress','queued','waiting','requested','pending']) {
  test(`an existing ${status} run blocks duplicate dispatch but retains stale monitoring`, async () => {
    const f = fixture({ runs: [run(status)] });
    const result = await f.dispatcher(controller, env); assert.equal(result.outcome, 'skip_active_run');
    assert.equal(result.publication.state, 'stale'); assert.equal(f.logs[0].level, 'error'); assert.equal(f.posts().length, 0);
  });
}
test('any recently created run cools down dispatch across fresh isolates, including failed runs', async () => {
  for (const conclusion of ['success','failure','cancelled']) {
    const f = fixture({ runs: [{ ...run('completed', 5), conclusion }] });
    assert.equal((await f.dispatcher(controller, env)).outcome, 'skip_recent_run'); assert.equal(f.posts().length, 0);
  }
});
test('a recent publication prevents an unnecessary duplicate even with no listed run', async () => {
  const f = fixture({ runs: [], publication: manifest(20) });
  const result = await f.dispatcher(controller, env); assert.equal(result.outcome, 'skip_recent_publication');
  assert.equal(result.publication.state, 'fresh_metadata'); assert.equal(f.posts().length, 0);
});
test('concurrent same-isolate triggers share one request sequence', async () => {
  const f = fixture(); const [a,b] = await Promise.all([f.dispatcher(controller, env), f.dispatcher(controller, env)]);
  assert.equal(a, b); assert.equal(f.posts().length, 1);
});
test('redelivery cannot hide an earlier authentication failure behind a healthy skip', async () => {
  const f = fixture({ respond: url => url === RUNS_URL ? new Response('', { status: 401 }) : undefined });
  await f.dispatcher(controller, env); const result = await f.dispatcher(controller, env);
  assert.equal(result.outcome, 'skip_duplicate_slot'); assert.equal(result.ok, false);
  assert.equal(result.previousOutcome, 'authentication_failed'); assert.equal(f.calls.length, 1);
});
test('duplicate suppression cannot extend the two-hour metadata freshness clock', async () => {
  let clock = NOW; const logs=[];
  const run = createDispatcher({ now: () => clock, fetcher: async url => url === RUNS_URL
    ? Response.json({ workflow_runs: [] }) : url === MANIFEST_URL ? Response.json(manifest(119)) : Response.json({ workflow_run_id: 123 }),
    logger:{info:s=>logs.push(JSON.parse(s)),error:s=>logs.push(JSON.parse(s))} });
  const first=await run(controller,env); assert.equal(first.publication.state,'fresh_metadata');
  clock += 2*60000;
  const next=await run(controller,env); assert.equal(next.outcome,'skip_duplicate_slot'); assert.equal(next.publication.state,'stale');
  assert.equal(next.publication.generatedAt,first.publication.generatedAt); assert.equal(next.publication.ageSeconds,121*60);
});
test('a new publication timestamp does not renew old retained evidence', async () => {
  const p = manifest(121); p.refresh = { status: 'failed', attemptedAt: iso(0), lastSuccessfulAt: iso(121) };
  const f = fixture({ publication: p }); const result = await f.dispatcher(controller, env);
  assert.equal(result.publication.state, 'stale'); assert.equal(result.publication.generatedAt, iso(121)); assert.equal(f.posts().length, 1);
});
test('still-fresh retained failed publication is distinguished and eligible for a later refresh', async () => {
  const p = manifest(20); p.refresh.status = 'failed'; p.refresh.attemptedAt = iso(0);
  const f = fixture({ publication: p }); const result = await f.dispatcher(controller, env);
  assert.equal(result.publication.state, 'retained_after_failed_refresh'); assert.equal(f.posts().length, 1);
});
test('advancing success/release metadata cannot freshen old source evidence', async () => {
  const p = manifest(121); p.refresh = { status: 'success', attemptedAt: iso(0), lastSuccessfulAt: iso(0) };
  const result = await fixture({ publication: p }).dispatcher(controller, env);
  assert.equal(result.publication.state, 'stale'); assert.equal(result.publication.generatedAt, iso(121));
});
test('the 90-minute publication warning does not extend or mislabel its freshness', async () => {
  const f = fixture({ publication: manifest(95) }); const result = await f.dispatcher(controller, env);
  assert.equal(result.publication.state, 'fresh_metadata'); assert.equal(f.logs[0].level, 'error');
  assert.equal(f.logs[0].publicationWarning, 'approaching_expiry');
});
test('original freshness window is exactly two hours; upstream source time is separately enforced', async () => {
  for (const [minutes,state] of [[120,'fresh_metadata'],[120.01,'stale']]) {
    const f = fixture({ publication: manifest(minutes) }); assert.equal((await f.dispatcher(controller, env)).publication.state, state);
  }
  const p = manifest(1); p.sourceUpdatedAt = iso(121);
  assert.equal((await fixture({ publication: p }).dispatcher(controller, env)).publication.state, 'stale');
});
test('unavailable manifest can trigger a seed refresh but is never described as fresh', async () => {
  const f = fixture({ respond: url => url === MANIFEST_URL ? new Response('missing', { status: 404 }) : undefined });
  const result = await f.dispatcher(controller, env); assert.equal(result.outcome, 'dispatch_accepted');
  assert.equal(result.publication.state, 'manifest_unavailable'); assert.equal(f.logs[0].level, 'error');
});
test('invalid metadata cannot appear fresh', async () => {
  for (const mutate of [p => { p.generatedAt = iso(-2); }, p => { p.index.bytes = 90000000; }, p => { p.index.url = 'https://evil.example/x'; },
    p => { p.refresh.lastSuccessfulAt = iso(-10); }, p => { p.tripCount = 0; }, p => { p.source = 'https://evil.example/source'; }]) {
    const p = manifest(1); mutate(p); const f = fixture({ publication: p });
    assert.equal((await f.dispatcher(controller, env)).publication.state, 'invalid_manifest');
  }
});
test('invalid calendar/offset timestamps cannot appear fresh', async () => {
  for (const date of ['2026-02-30T22:41:00Z', '2026-11-04T24:00:00Z', '2026-11-04T22:41:00-01:00']) {
    const p = manifest(1); p.generatedAt = date;
    assert.equal((await fixture({ publication: p }).dispatcher(controller, env)).publication.state, 'invalid_manifest');
  }
});
test('authenticated API redirects/errors and malformed run lists fail closed', async () => {
  for (const body of [{}, { workflow_runs: [run('unknown')] }, { workflow_runs: [{ ...run(), head_branch: 'other' }] }]) {
    const f = fixture({ respond: url => url === RUNS_URL ? Response.json(body) : undefined });
    assert.equal((await f.dispatcher(controller, env)).outcome, 'invalid_run_list'); assert.equal(f.posts().length, 0);
  }
  const f = fixture({ respond: url => url === RUNS_URL ? new Response('', { status: 302, headers: { location: 'https://evil.example/' } }) : undefined });
  assert.equal((await f.dispatcher(controller, env)).outcome, 'github_api_failed'); assert.equal(f.calls.length, 1);
});
test('oversized run list fails closed; oversized manifest is monitored without trusting it', async () => {
  const f = fixture({ respond: url => url === RUNS_URL ? new Response('x', { headers: { 'content-length': '200000' } }) : undefined });
  assert.equal((await f.dispatcher(controller, env)).outcome, 'invalid_response'); assert.equal(f.posts().length, 0);
  const g = fixture({ respond: url => url === MANIFEST_URL ? new Response('x'.repeat(8200)) : undefined });
  assert.equal((await g.dispatcher(controller, env)).publication.state, 'oversized_response');
});
test('public GitHub release redirects never receive the token', async () => {
  const asset = 'https://release-assets.githubusercontent.com/fixture';
  const f = fixture({ publication: manifest(1), respond: (url, options) => {
    if (url === MANIFEST_URL) return new Response(null, { status: 302, headers: { location: asset } });
    if (url === asset) { assert.equal(options.headers.Authorization, undefined); return Response.json(manifest(1)); }
  } });
  assert.equal((await f.dispatcher(controller, env)).outcome, 'skip_recent_publication');
  for (const c of f.calls.filter(c => c.url !== RUNS_URL)) assert.equal(c.options.headers.Authorization, undefined);
});
test('latest manifest follows the real two-stage same-repository release redirect safely', async () => {
  const immutable = 'https://github.com/elilinden/transitblend-mta-data/releases/download/mta-schedule-fixture/manifest.json';
  const asset = 'https://release-assets.githubusercontent.com/fixture';
  const f = fixture({ respond: (url, options) => {
    if (url === MANIFEST_URL) return new Response(null, { status: 302, headers: { location: immutable } });
    if (url === immutable) return new Response(null, { status: 302, headers: { location: asset } });
    if (url === asset) { assert.equal(options.headers.Authorization, undefined); return Response.json(manifest(1)); }
  } });
  assert.equal((await f.dispatcher(controller, env)).outcome, 'skip_recent_publication');
  assert.equal(f.posts().length, 0);
});
test('Worker entry point exports only supported handler objects/functions', async () => {
  const entry = await import('./worker.mjs');
  assert.deepEqual(Object.keys(entry), ['default']);
  assert.equal(typeof entry.default.scheduled, 'function'); assert.equal(typeof entry.default.fetch, 'function');
});
test('untrusted/looping asset redirects never cause a request to another host or local network', async () => {
  for (const target of ['https://evil.example/x','http://127.0.0.1/','https://github.com/other/repo','https://user:pass@release-assets.githubusercontent.com/x']) {
    const f = fixture({ respond: url => url === MANIFEST_URL ? new Response(null, { status: 302, headers: { location: target } }) : undefined });
    const result = await f.dispatcher(controller, env); assert.equal(result.publication.state, 'invalid_manifest_redirect');
    assert.ok(!f.calls.some(c => c.url === target));
  }
});
test('bad/old/future triggers cause zero requests', async () => {
  for (const c of [{ ...controller, cron: '* * * * *' }, { ...controller, scheduledTime: NOW-121*60000 }, { ...controller, scheduledTime: NOW+2*60000 }, {}]) {
    const f = fixture(); assert.equal((await f.dispatcher(c, env)).outcome, 'invalid_or_old_trigger'); assert.equal(f.calls.length, 0);
  }
});
test('a delayed timer can request a current refresh without treating its old trigger time as evidence', async () => {
  const f=fixture(); const result=await f.dispatcher({...controller,scheduledTime:NOW-20*60000},env);
  assert.equal(result.outcome,'dispatch_accepted'); assert.equal(result.publication.state,'stale');
  assert.equal(result.publication.generatedAt,iso(121)); assert.equal(result.validatedPublication,'not_checked');
});
test('HTTP never exposes a dispatch action and environment cannot select a different repo/endpoint', async () => {
  const response = worker.fetch(new Request('https://example.test/dispatch?repo=other', { method: 'POST' }));
  assert.equal(response.status, 404);
  const f = fixture(); await f.dispatcher(controller, { ...env, WORKFLOW_URL: 'https://evil.example/', REPOSITORY: 'other/repo', REF: 'other' });
  assert.ok(f.calls.every(c => [RUNS_URL, MANIFEST_URL, DISPATCH_URL].includes(c.url)));
  assert.equal(f.posts()[0].url, DISPATCH_URL); assert.deepEqual(JSON.parse(f.posts()[0].options.body), { ref: 'main' });
});
test('bootstrap is inert, activation has one half-hourly timer, and neither config has routes or paid bindings', async () => {
  const active = JSON.parse(await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
  const bootstrap = JSON.parse(await readFile(new URL('./wrangler.bootstrap.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(active.triggers.crons, [CRON]); assert.deepEqual(bootstrap.triggers.crons, []);
  assert.deepEqual({ ...active, triggers: undefined }, { ...bootstrap, triggers: undefined });
  assert.equal(active.workers_dev, false); assert.equal(active.preview_urls, false); assert.deepEqual(active.routes, []);
  assert.deepEqual(Object.keys(active).sort(), ['compatibility_date','main','name','observability','preview_urls','routes','triggers','workers_dev']);
});

// Actual workerd rejects RequestInit.redirect='error' before outbound I/O.
test('authenticated GitHub requests use the supported fail-closed manual redirect mode', async () => {
  const f = fixture({ respond: (url, options) => {
    if (url === RUNS_URL || url === DISPATCH_URL) assert.equal(options.redirect, 'manual');
  } });
  assert.equal((await f.dispatcher(controller, env)).outcome, 'dispatch_accepted');
  assert.equal(f.posts().length, 1);
});
for (const atDispatch of [false, true]) {
  test(`GitHub redirect at ${atDispatch ? 'dispatch' : 'run lookup'} is never followed with credentials`, async () => {
    const f = fixture({ respond: (url, options) => {
      if (url === RUNS_URL || url === DISPATCH_URL) assert.equal(options.redirect, 'manual');
      if (url === (atDispatch ? DISPATCH_URL : RUNS_URL)) {
        return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/' } });
      }
    } });
    const result = await f.dispatcher(controller, env);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'github_api_failed');
    assert.equal(result.httpStatus, 302);
    assert.equal(f.posts().length, atDispatch ? 1 : 0);
    assert.ok(f.calls.every(call => call.url !== 'https://untrusted.example/'));
    assert.ok(!JSON.stringify(f.logs).includes(TOKEN));
    assert.equal((await f.dispatcher(controller, env)).outcome, 'skip_duplicate_slot');
    assert.equal(f.posts().length, atDispatch ? 1 : 0);
  });
}
