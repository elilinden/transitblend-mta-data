// Standalone GitHub Actions publisher. This file contains no app credentials.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOURCE = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip';
const tagPattern = /^mta-schedule-[\w.-]+$/;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function candidateManifest(metadata, repository, tag, now = new Date().toISOString()) {
  if (!/^[-\w.]+\/[-\w.]+$/.test(repository) || !tagPattern.test(tag) || !/^[a-f0-9]{64}$/.test(metadata.sha256)
    || metadata.source !== SOURCE || !Number.isInteger(metadata.tripCount) || metadata.tripCount < 1000 || metadata.tripCount > 150000
    || !Number.isInteger(metadata.bytes) || metadata.bytes < 1 || metadata.bytes > 20000000 || !iso(metadata.generatedAt)
    || Date.parse(now) - Date.parse(metadata.generatedAt) > 7200000 || Date.parse(metadata.generatedAt) > Date.parse(now) + 60000) throw Error('Invalid publication candidate');
  return { version: 1, source: SOURCE, generatedAt: metadata.generatedAt, tripCount: metadata.tripCount,
    index: { url: `https://github.com/${repository}/releases/download/${tag}/schedule-index-${metadata.sha256}.json.gz`, sha256: metadata.sha256, bytes: metadata.bytes },
    refresh: { status: 'success', attemptedAt: now, lastSuccessfulAt: now } };
}

export function failureManifest(previous, repository, now = new Date().toISOString()) {
  // A failed attempt may point only to this repository's existing immutable
  // release asset. It never changes the good index's timestamps or checksum.
  const prefix = `https://github.com/${repository}/releases/download/`;
  if (previous?.version !== 1 || previous.source !== SOURCE || !previous.index?.url?.startsWith(prefix)
    || !iso(previous.generatedAt) || !iso(previous.refresh?.lastSuccessfulAt)
    || !/^[a-f0-9]{64}$/.test(previous.index.sha256)
    || !previous.index.url.endsWith(`/schedule-index-${previous.index.sha256}.json.gz`)) throw Error('No safe previous publication');
  return { ...previous, refresh: { status: 'failed', attemptedAt: now, lastSuccessfulAt: previous.refresh.lastSuccessfulAt } };
}

/** Draft + uploaded assets + publish is the visibility transaction. */
export async function publishRelease(api, manifest, bytes, tag) {
  const draft = await api('POST', '/releases', { tag_name: tag, name: tag, draft: true, body: 'Official MTA-derived subway schedule evidence. No rider data.' });
  try {
    if (bytes) await api('UPLOAD', `/releases/${draft.id}/assets`, bytes, `schedule-index-${manifest.index.sha256}.json.gz`);
    await api('UPLOAD', `/releases/${draft.id}/assets`, Buffer.from(JSON.stringify(manifest)), 'manifest.json');
    return await api('PATCH', `/releases/${draft.id}`, { draft: false, make_latest: 'true' });
  } catch (error) {
    // A half-uploaded draft is invisible to /latest/download/manifest.json.
    try { await api('DELETE', `/releases/${draft.id}`); } catch { /* old latest remains valid */ }
    throw error;
  }
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (process.env.GITHUB_ACTIONS !== 'true' || !/^[-\w.]+\/[-\w.]+$/.test(repository ?? '') || !process.env.GITHUB_TOKEN) throw Error('Run only in the dedicated public data repository workflow');
  const token = process.env.GITHUB_TOKEN;
  async function request(url, options) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000), redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}`, ...options?.headers } });
    if (!response.ok) throw Error(`GitHub operation failed (${response.status})`); // Never print provider bodies or headers.
    return response.status === 204 ? undefined : response.json();
  }
  const repo = await request(`https://api.github.com/repos/${repository}`);
  if (repo.private || repo.fork) throw Error('Publication requires the separate public, non-fork data-only repository');
  const api = (method, suffix, body, name) => request(`${method === 'UPLOAD' ? 'https://uploads.github.com' : 'https://api.github.com'}/repos/${repository}${suffix}${name ? `?name=${encodeURIComponent(name)}` : ''}`, {
    method: method === 'UPLOAD' ? 'POST' : method,
    headers: { 'Content-Type': method === 'UPLOAD' ? name.endsWith('.gz') ? 'application/gzip' : 'application/json' : 'application/json' },
    ...(body === undefined ? {} : { body: method === 'UPLOAD' ? body : JSON.stringify(body) }),
  });
  let previous;
  try {
    const latest = await api('GET', '/releases/latest');
    const asset = latest.assets.find(a => a.name === 'manifest.json');
    if (asset?.size <= 8192) {
      const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(15000) });
      if (response.ok) { const text = await response.text(); if (text.length <= 8192) previous = JSON.parse(text); }
    }
  } catch { /* Initial seed has no preceding release. */ }
  const tag = `mta-schedule-${new Date().toISOString().replace(/[:]/g, '-')}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  let manifest, bytes;
  try {
    if (process.argv.includes('--failed')) throw Error('Refresh failed');
    const file = path.resolve('schedule-index.json.gz');
    const metadata = JSON.parse(execFileSync('python3', ['scripts/mta_index_validation.py', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    if (previous && metadata.tripCount < previous.tripCount * 0.5) throw Error('Unexpected loss of more than half the trips; manual investigation required');
    manifest = candidateManifest(metadata, repository, tag);
    bytes = await readFile(file);
  } catch {
    if (!previous) throw Error('Refresh failed and no previous index is available; latest was not changed');
    manifest = failureManifest(previous, repository);
  }
  await publishRelease(api, manifest, bytes, tag);
  // Keep bounded storage, and never delete the release referenced by a failure
  // marker. Cleanup runs only after a successful index publication.
  if (bytes) {
    const releases = await api('GET', '/releases?per_page=100');
    const ours = releases.filter(r => !r.draft && tagPattern.test(r.tag_name)).sort((a,b) => Date.parse(b.published_at)-Date.parse(a.published_at));
    for (const old of ours.slice(8)) {
      await api('DELETE', `/releases/${old.id}`);
      // Deleting a release does not remove its tag. Keep refs bounded too.
      try { await request(`https://api.github.com/repos/${repository}/git/refs/tags/${encodeURIComponent(old.tag_name)}`, { method: 'DELETE' }); } catch { /* harmless orphan tag */ }
    }
  }
  console.info(JSON.stringify({ published: true, refresh: manifest.refresh.status, generatedAt: manifest.generatedAt, tripCount: manifest.tripCount }));
  if (!bytes) process.exitCode = 1; // Workflow failures remain visible even when last good data was preserved.
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Schedule publication failed; inspect the workflow and existing feed health.'); process.exitCode = 1; });
