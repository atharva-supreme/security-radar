# Security Radar

Automated dependency vulnerability monitoring.

A scheduled scan that reads vendor security advisories the minute they are published, compares them with what our projects actually have installed, and writes the result to `report.json`. A Claude Code routine reads that file every morning and sends the email and Slack message. This repo does the finding; the routine does the telling.

Why not `pnpm audit`, Dependabot or OSV: they all read the GitHub Advisory Database, which only lists an advisory after GitHub's curation team has reviewed it. Measured on the Next.js releases of 22 Sep and 14 Oct 2026, that review took 8 days each time. The maintainer's own repository advisory, which this scan reads first, is live the same minute as the fix.

## Scope is the watchlist, nothing else

`watchlist.json` is the only place scope lives. Every row in `repos[]` is one app (a repo plus a lockfile path); every row in `packages[]` is one package to watch. The scan checks exactly what is listed: ten rows means ten apps, one row means one app. The report groups apps by repo (`project`), so a repo with two lockfiles shows as one project with two apps. The Claude routine that sends the email reads the report and adapts to however many projects it finds, with no per-project configuration anywhere else.

**Branches.** `branches` at the top of the watchlist (today `["main", "staging"]`) applies to every repo row: each row is scanned once per branch, and the report keeps a separate project row and separate app rows per branch, because the two branches carry different lockfiles. A repo row's own `branches` list overrides the default; a `ref` pins one branch or commit.

Today it lists two projects, **vectorlabs-bigcommerce-sanity** and **bostonbioproducts-bigcommerce-sanity** (`web` and `sanity` apps each, on both branches), and ten packages. The other eleven SupremeOpti apps found on 2026-10-27 are in `watchlist.all-repos.json`; copy a row into `watchlist.json` to add it. A `label` on a repo row is optional and defaults to the lockfile's folder.

## How a scan works

Every 6 hours (07:00, 13:00, 19:00 and 01:00 IST) the `watch` workflow runs `node watch.mjs --scan-only`, which:

1. Fetches repository-level advisories for every package's GitHub repo (maintainer-published, same minute as the release) and the GitHub Advisory Database entries for every package (reviewed, about a week later). The two describe affected ranges differently, so they are merged: the reviewed range wins when it exists, and the maintainer's fixed version fills in what the reviewed record leaves blank.
2. Fetches the Node.js vulnerability feed. Node has no npm package, so the official feed is its source.
3. Records every advisory in `state.json` with the date it was first seen. An advisory met for the first time more than a week after publication is dated by publication, so adding a package to the watchlist does not flag its history as new.
4. Reads each app's lockfile from GitHub and checks every installed version against every advisory's range. A package installed at two versions is checked at both.
5. Confirms each fixed version is actually on the npm registry.
6. Writes `report.json` and commits it with `state.json`. The git log is the audit trail.

The scan posts nothing and opens nothing. The Slack and issue code paths still exist for a run without `--scan-only`, but the workflow does not use them.

## report.json

| Field | Meaning |
| --- | --- |
| `status` | `RED` (an open critical or high), `AMBER` (open moderate or low only), `GREEN` (nothing open), `UNKNOWN` (a lockfile could not be read or a source failed; see `errors` and `warnings`) |
| `summary` | counts: open, by severity, `newOpen`, `newNotAffecting` |
| `projects[]` | one row per repo, worst status first: `project`, `status`, `open`, `critical`, `high`, `newOpen`, `apps`, `affectedApps` |
| `apps[]` | per app: `project`, `label`, `installed` versions, `open[]` advisories (sorted critical first, each with `fixed`, `fixedOnNpm` and `isNew`), `upgrades[]` and the `command` that applies them |
| `newNotAffecting[]` | advisories first seen in the last 26 hours that hit none of our installed versions |
| `feedItemsNew[]` | Node.js feed posts first seen this run |
| `checked` | the package list, app count, and sources used |

`isNew` means first seen within the last 26 hours, so a daily reader never misses one and rarely sees one twice.

## Setup

1. Repository secret `REPO_READ_TOKEN`: a fine-grained personal access token with read-only **Contents** on every repo in `watchlist.json`. The workflow's own token cannot read private repos in another account, and without this the apps show as `UNKNOWN`.
2. The schedule is on. `Actions > watch > Run workflow` runs it by hand; tick `dry_run` to see the report in the log without committing.
3. The Claude routine clones this repo and reads `report.json`. It needs the Claude GitHub App installed on this repository.

## Running locally

```bash
export GITHUB_TOKEN=$(gh auth token)   # a login that can read the lockfiles
npm test
node watch.mjs --dry-run --scan-only   # writes report.json, leaves state.json alone
```

`node watch.mjs --dry-run --scan-only --forget GHSA-673q-mjm6-r5xr` makes that advisory count as new again, which is the way to see what a release day looks like.

## Files

| File | What |
| --- | --- |
| `watchlist.json` | Packages (with the GitHub repo that publishes their advisories), apps (repo, lockfile, label), feeds. The only routine maintenance |
| `watchlist.all-repos.json` | The rest of the org's apps, for when the pilot widens |
| `state.json` | Every advisory and feed item ever seen. Committed by the workflow; edit only via `--forget` |
| `report.json` | The latest scan result. Committed by the workflow |
| `watch.mjs` | The run. No npm dependencies |
| `src/` | GitHub client, semver range check, lockfile readers, feed parser, report builder, message formats |
| `.github/workflows/watch.yml` | The schedule and the manual-run inputs |

## What it does not do

- It does not upgrade anything. `report.json` names the fixed version and the command; applying it is a person's job, or a later automation's.
- It does not parse Node.js version ranges from the Node blog. A feed item is reported with the Node version each app declares.
- It does not catch an advisory a maintainer never files anywhere. Sanity has none on record in either GitHub source as of October 2026.
