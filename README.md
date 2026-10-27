# security-watch

One scheduled job that watches the packages and runtimes our projects depend on and posts a single alert the moment a vendor publishes a security fix. Day one it watches Next.js and the packages its fixes ship through. Sanity and Node.js are rows in the same watchlist.

The design and its evidence are in the plan document "Security Advisory Watcher". The short version: the global GitHub Advisory Database trailed Vercel's October 14 2026 release by 8 days, and `pnpm audit`, Dependabot and OSV all read that database. This job reads the vendor's own repository advisories first, which publish in the same minute as the fix.

## How it works

Every 6 hours a GitHub Actions run executes `watch.mjs`, which:

1. Fetches repository-level advisories for every repo in the watchlist (same minute as release) and global advisories for every package (complete, a week late).
2. Fetches each RSS or Atom feed in the watchlist. Node.js has no npm package, so its official feed is the source.
3. Diffs every advisory id and feed link against `state.json`. New ids are alerts. A known id whose fixed version changed is re-alerted.
4. Reads each listed repo's lockfile and checks the installed versions against each advisory's affected range. The two GitHub sources describe ranges differently, so they are combined: the global database's reviewed range wins when it exists, and the maintainer's fixed version fills in what the global record leaves blank. For a critical or high advisory, the fixed version is also checked against the npm registry so the alert says whether it can be installed yet.
5. Opens one GitHub issue per new advisory in this repo, then posts to Slack: critical and high one message each, medium and low batched into one.
6. Commits `state.json` back. The git log is the audit trail.

Once a day, when nothing is new, it posts a quiet summary that names any repo still on an affected version. A run where a source or a notification failed exits non-zero so the Actions run goes red and the errors are posted to Slack. A lockfile that cannot be read is a warning, not a failure: that repo shows as "unknown" in alerts until the read token is fixed.

## Files

| File | What |
| --- | --- |
| `watchlist.json` | Packages (with their GitHub repo), repos (with lockfile path), feeds. Editing this is the only maintenance |
| `state.json` | Every advisory and feed item ever seen. Committed by the workflow. Do not edit by hand except to `--forget` |
| `watch.mjs` | The run. No npm dependencies |
| `src/` | GitHub client, semver range check, lockfile readers, feed parser, message formats |
| `.github/workflows/watch.yml` | The schedule and the manual-run inputs |

## Setup

1. Repository secrets:
   - `SLACK_WEBHOOK_URL`: an incoming webhook for the channel that should receive alerts. Without it, issues are still opened and the run still succeeds.
   - `REPO_READ_TOKEN`: a fine-grained personal access token with read-only Contents on every repo in `watchlist.json`. Without it, the workflow's own token is used, which can read public repos only.
2. First run: `node watch.mjs --baseline` locally or via the manual workflow. It records everything currently published and alerts on nothing. Without this, the first run would open an issue for every historical advisory.
3. Dry run against real data: `node watch.mjs --dry-run --forget GHSA-673q-mjm6-r5xr,GHSA-2464-fhr4-w9xw,GHSA-p3m5-59mp-jv5r` prints the three October 14 alerts exactly as they would be posted.

## Running locally

```bash
export GITHUB_TOKEN=$(gh auth token)
node --test test/*.test.mjs
node watch.mjs --dry-run
```

## Adding a package, repo or feed

Add a row to `watchlist.json`. A package row needs the npm name and the GitHub repo that publishes its advisories. A repo row needs the repo and the lockfile path, and optionally a `packageJson` path so the Node.js version it declares shows up in Node feed alerts. A feed row needs a name and a URL. Mark a feed `"informational": true` to record it without alerting.

## What it does not do

- It does not upgrade anything. The alert names the fixed version and the affected repos. The upgrade is a person's job, or a later automation's.
- It does not parse Node.js version ranges from the Node blog. A Node feed alert lists what each repo declares and links the post.
- It does not catch an advisory that a maintainer never files anywhere. Sanity has none on record in either GitHub source as of October 2026.
