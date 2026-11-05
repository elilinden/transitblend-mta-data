# Free fallback timer for the MTA data workflow

**Deployment record: activated on 4 November 2026.** Keep the native GitHub schedule enabled until a replacement's natural recurring executions and validated publications have been observed and the transition reviewed. The data repository's `main` workflow is authoritative for its current cron; this directory does not change it.

This Worker only dispatches **one fixed GitHub workflow on `main` in `elilinden/transitblend-mta-data`**. The existing standard GitHub-hosted runner downloads/builds/validates the official MTA schedule and atomically publishes GitHub Releases. No MTA archive or index processing, rider data, Google/Transit/rideshare API calls, storage binding, paid service or always-on server belongs in Cloudflare.

## Observed activation evidence — 4 November 2026

The 30-minute cron was enabled without adding HTTP routes or paid bindings. The first natural event exposed a Workers runtime incompatibility: `redirect: "error"` is unsupported and throws before I/O. The two authenticated calls now use `manual`, rejecting non-2xx redirects without forwarding credentials. The fix is commit `2a8c75b`; 43 mocked checks and a local workerd reproduction passed after correction.

Actual unattended results, all times UTC on 5 November:

- **02:11:36 Cloudflare cron:** dispatched [run 41953567738](https://github.com/elilinden/transitblend-mta-data/actions/runs/41953567738). Acquisition 02:11:46; publication 02:12:07; 55,545 trips. Downloaded bytes, SHA-256, schema/native chronology and evaluation-backend loading were verified. Worker CPU: 5 ms, no exception.
- **02:38:40 native GitHub `schedule` event:** [run 41956548137](https://github.com/elilinden/transitblend-mta-data/actions/runs/41956548137) acquired another valid index at 02:38:46 and published at 02:39:15, again 55,545 trips. Its checksum, advancing acquisition/publication timestamps and evaluation-backend load were independently verified. This was a genuine schedule event, not a manual dispatch. One resumed native run does not prove reliable native recurrence.
- **02:41:36 Cloudflare cron:** `skip_recent_run`, fresh publication metadata, no exception, 6 ms CPU. It correctly avoided duplicating the recent native refresh.

These are **two automatic publications from different trigger sources**, not two Cloudflare-dispatched publications. The corrected Worker has one verified live dispatch/publication and one verified deduplication cycle. No manual refresh was used during this activation. The initial failed event is not counted as a successful refresh. Native GitHub scheduling remains enabled; disabling either timer requires a separately reviewed transition and longer observation.

The evaluation backend recovered from a genuinely stale HTTP 503 to HTTP 200 with the exact validated `github_releases` generations. A short latest-redirect/backend-refresh propagation delay was observed. The two-hour freshness limit and strict trip matching were unchanged. Production application configuration, release and installed app were not modified. This point-in-time record is not a continuing availability guarantee; use the monitoring steps below.

## What it does

- One off-hour UTC Cron Trigger, `11,41 * * * *` (48 opportunities/day).
- No public HTTP route or preview URL; even an accidentally enabled HTTP endpoint returns 404 and cannot dispatch.
- Only `GH_ACTIONS_TOKEN` is read from environment bindings. Repository, workflow ID, branch and API URLs are fixed in code, never HTTP/configurable targets.
- Checks the five latest workflow runs and small public manifest before dispatch. Active runs, runs created in the previous 10 minutes, or successful manifest metadata acquired less than 25 minutes ago suppress unnecessary dispatches.
- Coalesces concurrent same-isolate events and remembers recent scheduled slots. GitHub's existing workflow concurrency remains the publication guard. This is **best-effort deduplication**, not distributed exactly-once delivery: two cold isolates can race before either sees a new run. No immediate retry is made after a timeout/ambiguous POST result.
- Bounds request/body size, deadlines and asset redirects. Never sends the bearer token to release-asset hosts, prints raw provider errors/bodies or logs credentials.
- Logs accepted workflow run ID separately from **completion: not_checked / validatedPublication: not_checked**. A 200 dispatch response is not proof of a valid refresh.
- Logs stale/malformed/unavailable/failure-retained publication metadata as errors even when a refresh is dispatched or a concurrent run means dispatch is skipped. Metadata is **not checksum-verified index evidence**; the existing backend and publisher remain responsible for validating actual bytes and native identities.

`generatedAt`, optional `sourceUpdatedAt`, the two-hour freshness cutoff, checksum validation, immutable asset publication and strict MTA matching remain unchanged. A failure manifest cannot make retained old evidence fresh. The Worker never edits a release or invents a successful update timestamp.

## Tests and local build (no credentials or external dispatch)

From this directory, using Node 22 or later:

```sh
node --test worker.test.mjs
npx --yes wrangler@4.157.0 deploy --dry-run
```

The tests use explicit fake credentials and mocked HTTP responses only. They cover acceptance versus publication, authentication/permission failures, expired/rejected tokens, rate limits, unavailable endpoints, timeouts, malformed/oversized responses, same-isolate/cross-instance best-effort gates, freshness, retained failed evidence, redirects, trigger validation and disabled HTTP routes. The dry run compiles locally; it does not upload or establish Cloudflare performance/recurrence.

## Account and dedicated token setup — only if this fallback is selected

1. Create/sign into a Cloudflare account and confirm **Workers Free**. Do not upgrade, add a card for a paid product, create R2/KV/Queues/containers or buy a domain. Keep this Worker separate from any paid service. No Cloudflare account or authorization is assumed by these files.
2. On GitHub, open **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**. Use resource owner **elilinden**, **Only select repositories → transitblend-mta-data**, and **Repository permissions → Actions: Read and write**. Required metadata read access is sufficient otherwise. Do not grant Contents write, private TransitBlend access or a classic/broad token. Set an expiry (for example 90 days) and record a reminder to rotate it before then.
3. Keep the token out of this repository, local files, `.env.local`, `.dev.vars`, commands/arguments, screenshots, chat and logs. It goes directly into the masked Cloudflare Worker Secret entry/prompt below. The worker's token can dispatch/read runs; the workflow's own short-lived `GITHUB_TOKEN` performs publication.

### Deliberate activation sequence

Run from this directory. These are **instructions for an authorized setup**, not commands executed by tests or automatically by this repository.

```sh
npx --yes wrangler@4.157.0 login
npx --yes wrangler@4.157.0 deploy --config wrangler.bootstrap.jsonc
npx --yes wrangler@4.157.0 secret put GH_ACTIONS_TOKEN --config wrangler.bootstrap.jsonc
```

The first deployment has **no cron and no HTTP routes**. Enter the dedicated token only into the interactive secret prompt. `secret put` deploys a secret version; using the bootstrap config keeps the setup inert. Alternatively use Cloudflare **Workers & Pages → transitblend-mta-refresh → Settings → Variables and Secrets → Add → type Secret → name GH_ACTIONS_TOKEN** and save/deploy. Never choose a plain-text variable.

After reviewing the Free plan, script/config, token repository restrictions and bootstrap's empty trigger list, enable the timer deliberately:

```sh
npx --yes wrangler@4.157.0 deploy --config wrangler.jsonc
```

Confirm the dashboard has one `11,41 * * * *` trigger, no public routes and no paid bindings. Trigger changes can take up to 15 minutes to propagate. The first live attempt should be one natural cron cycle; do not click repeated test invocations or dispatch another refresh merely because the call was accepted. A missing secret fails before any network call. The provided bootstrap makes it unnecessary to expose an HTTP setup endpoint.

## Verify unattended operation and monitor it

Use **Workers & Pages → this Worker → Observability/Logs and Metrics**. Every actual timer invocation emits one sanitized `mta_schedule_dispatcher` record (or a coalesced invocation shares the same result). Outcomes such as `authentication_failed`, `permission_denied`, `rate_limited`, `timeout`, `workflow_inaccessible` or `missing_secret` require investigation. Do not infer token expiry specifically from 401: an invalid/revoked token produces the same response. Check its configured expiry and rotate through the Worker Secret UI/prompt, without pasting it into troubleshooting logs.

For each of at least **two natural unattended cycles**, correlate:

1. Cloudflare's cron invocation timestamp, not a dashboard/manual test.
2. Its `dispatch_accepted` record and returned `workflowRunId` (or an honest skip because the native workflow already did the work).
3. That exact GitHub workflow run's build/validation and publisher steps.
4. The release manifest's successful refresh plus advancing `generatedAt` and `lastSuccessfulAt`; verify the referenced checksum/index through the backend.
5. Actual `/api/health/transit` JSON on the existing evaluation backend: `source=github_releases`, `available=true`, `state=fresh`, valid trip count and expected generation time. Health must be inspected again after a later cycle/cold load.

A `workflow_dispatch` event alone does not prove Cloudflare ran unattended. A green GitHub job alone does not prove valid publication. A fresh manifest timestamp alone does not establish native MTA matching or real arrival accuracy.

A skip verifies monitoring/duplicate gates only; it does **not** verify POST permission or replacement readiness. Before disabling the native schedule, require at least **two natural Cloudflare cycles that actually dispatch and produce validated publications**, followed by transition review. If native GitHub scheduling is consistently doing the work, retain it and leave the unused fallback inactive rather than forcing extra refreshes just to justify another service.

Warn at about **90 minutes** without successful source acquisition; above **120 minutes** the backend must reject schedule evidence and retain safe scheduled timing. The Worker reports publication metadata state each time it runs, including if it skips dispatch. There is **no external watchdog/email alert provisioned** in this minimal setup: a timer that never runs cannot report its own absence. Review timer history and backend health independently; configure an independent free read-only freshness check if unattended alerting is required. Retain sanitized evidence before provider logs age out.

After an observation period (preferably overnight) and review, remove the native GitHub `schedule` entry in a separate change if Cloudflare becomes the primary timer. Keep `workflow_dispatch`. Until then, **do not disable the native schedule**. The two timers should usually suppress unnecessary duplicates through recent-run/publication gates, but are not a permanent active-active design.

## Costs and operational limits

The intended plan is **$0 subscription cost**: one Cloudflare Workers Free cron plus the existing standard runner in this public GitHub repository. Free limits include 100,000 requests/day, five Cron Triggers/account and 10 ms CPU per invocation; network waiting is separate. At 48 invocations/day, request count is small. Measure actual CPU after setup; keep the handler small rather than upgrading silently. The dry run/mock timing does not prove production CPU fits the Free cap.

No runtime dependencies are required. Wrangler is an optional pinned deployment tool, not bundled into the Worker. No guarantee of scheduler/MTA/GitHub availability is implied. GitHub execution/storage and token validity remain dependencies. Maintain/rotate the fine-grained token, review account notifications, keep the public runner/data repository maintained and monitor evidence age. These files neither change the backend configuration nor authorize a production app release.

Sources checked November 4, 2026: [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [routing configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).
