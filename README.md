# TransitBlend MTA schedule data

Dedicated **public data-only** repository. Contains maintenance scripts and official MTA-derived subway schedule evidence; no TransitBlend application code, credentials, API proxy, rider data or route searches. Data source: [MTA supplemented GTFS](https://www.mta.info/developers). This is schedule evidence, not a live prediction feed. MTA retains rights in its data; no ownership of MTA data or trademarks is asserted.

## Initial seed and activation

1. Create a separate public, non-fork repository, suggested name `transitblend-mta-data`. Upload these allowlisted files to its default branch. Do not upload the private app repository.
2. In **Settings → Actions → General**, allow the workflow. Its explicit `contents: write` permission must be permitted by your repository/organization policy. No personal access token or app credential is required.
3. Installing or updating the workflow/scripts on `main` starts a seed refresh automatically. It can also be started with **Actions → Refresh official MTA schedule evidence → Run workflow**. A successful run must publish a release with `manifest.json` and `schedule-index-<sha256>.json.gz`.
4. Confirm `https://github.com/OWNER/REPOSITORY/releases/latest/download/manifest.json` is public and fresh. Only then set the backend's server-only `MTA_GTFS_MANIFEST_URL` to that exact URL. A backend deployment is required to activate an environment change. Never set a `NEXT_PUBLIC_` variable.
5. Check `/api/health/transit` on the backend: expect `schedule.available=true`, `state=fresh`, a nonzero trip count and `refresh.state=success`. Exact trip matches additionally require fresh MTA realtime data and all existing identity checks.

## Refresh and failure behavior

Standard GitHub-hosted runners are free for public repositories. Scheduled runs at minutes 17 and 47 fetch the official ZIP, preserve native trip identities, validate chronology, dates, counts and size, then upload into an unpublished draft. The release becomes latest only after both assets exist. More than a 50% trip-count loss relative to the preceding release blocks replacement. Eight releases are retained after successful publication. Tags/assets from this workflow are the only deletion targets.

On a failed refresh the publisher can publish a small failure manifest referencing the preceding immutable valid asset. It retains the original index time and last successful update. The backend may use that evidence only within its original two-hour window. If GitHub publication itself fails, the old manifest remains and eventually becomes stale. A first run that fails has no usable seed and cannot fabricate one.

`generatedAt` reflects the archive acquisition/mtime used to build the index, **not an agency-reported vehicle prediction timestamp**. Runtime validates the gzip checksum and bounds again before use. Google/MTA planning continues with scheduled timing if no fresh index is available. No persistent Vercel filesystem or Vercel cron is required.

GitHub scheduled jobs may be delayed or dropped; public repository schedules are disabled after 60 days without repository activity. Enable workflow failure notifications, watch successful release timestamps, and periodically maintain the repository. Check freshness from outside GitHub for silent scheduling failures. This free architecture fails safely but does not promise continuous availability. It is suitable for evaluation and low-volume operation; a stronger uptime requirement needs a more reliable scheduler.

## Security and cost boundaries

Keep this repository public and data-only for free standard runner use and unauthenticated backend downloads. Do not add secrets, rider information, private tools, larger runners or paid third-party actions. Protect its default branch and review workflow changes. Release artifacts are not exposed through a paid API. The app never sends locations or credentials to this repository.

Before enabling it for production, review this setup and confirm MTA data-use terms, GitHub Actions permissions, the seed release, monitoring and the app/backend version. No Transit API or rideshare permissions are involved.
