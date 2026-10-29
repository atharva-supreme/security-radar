# CLAUDE.md — Security Radar handoff

Security Radar: automated dependency vulnerability monitoring for SupremeOpti. Written 2026-10-29
so a new session can continue without the chat history. Read this whole file before changing
anything. README.md explains the system to a developer; this file explains it to you, including
the decisions and the rules the owner set.

## Who you are working with

- Owner: Atharva (developer@supremeopti.com). GitHub `atharva-supreme`. Timezone Asia/Kolkata.
- Commits are authored as `Atharva-Supreme <253277179+atharva-supreme@users.noreply.github.com>`,
  passed with `-c user.name=… -c user.email=…` on every commit. Never the supremeopti.com address.
- You open pull requests; the owner merges them. `gh pr merge` is refused by the permission
  classifier ("merge without review"). Do not try to work around that.
- Never create repositories, push to a new destination, arm a schedule, delete anything remote,
  or post to Slack without the owner naming that destination first. The one standing permission:
  `node scripts/slack.mjs report.json --only Catalent` to test a layout change in the real channel,
  which the owner has asked for repeatedly. Nothing else goes to Slack without being asked.
- Secrets never pass through chat. The server holds them in `.env` (mode 600, git-ignored). The
  Slack webhook URL appears in this session's history and in the disabled cloud routine; do not
  print it in output.
- The owner's style: short requests, sometimes typed fast. Ask before building when the request
  branches ("don't act, discuss first" has been said more than once); when told "do it", do all of
  it. Show a demonstration from real data before changing a layout. The owner reads the Slack
  channel on a phone as well as a desktop.

## What the system is (one paragraph)

Once a day at 08:00 IST a cron job on the owner's Ubuntu 20.04 server (user `pragma`, checkout
`~/security-radar`) runs `server/daily.sh`: `node watch.mjs` reads every lockfile of the reported
projects on `main` and `staging` through the GitHub Contents API, checks every installed
package@version against the maintainers' own repository security advisories (live the same minute
as a release) and OSV.dev (reviewed, about a week later, plus malicious-package records), writes
`report.json`; the day's copy goes to `data/reports/YYYY-MM-DD.json`; `scripts/store.mjs` loads it
into MySQL; `claude -p server/narrative.prompt.md` writes a two-to-four-sentence paragraph;
`scripts/slack.mjs` builds and posts the Slack messages through an incoming webhook. The server is
the only copy of state and reports; nothing is pushed back to GitHub. Advisories only: a package
release that fixes nothing is never mentioned.

Why it exists: measured on the Next.js releases of 22 Sep and 14 Oct 2026, the GitHub Advisory
Database, OSV, `pnpm audit` and Dependabot all listed the advisory 8 days after the maintainers
published it. Reading the repository-level advisory closes that window. The owner's words: "we
don't have to wait for 7 to 8 days to fix."

## Where things are

| Thing | Location |
| --- | --- |
| Code | `atharva-supreme/security-radar` (private, owner's personal account; the SupremeOpti org token approval never came through). Local clone on the owner's PC: `C:\Git Projects\security-watch` (folder rename to security-radar failed, a handle was open; remote is correct) |
| Server | Ubuntu 20.04.6, node 22+, claude CLI on subscription login, mysql + phpMyAdmin. Cron line installed by `server/install.sh`, 08:00 IST converted to server-local time (cron ignores TZ for the schedule) |
| Slack | one channel, incoming webhook in `.env` as `SLACK_WEBHOOK_URL` |
| MySQL | database created by the owner in phpMyAdmin with an existing admin user; `MYSQL_URL` in `.env`; schema `server/schema.sql` |
| GitHub token | `REPO_READ_TOKEN` in `.env`: classic PAT with `repo` on the owner's account (5,000 requests/hour). A fine-grained PAT is stuck in SupremeOpti admin approval |
| Disabled, kept | GitHub Actions workflow `watch` (`gh workflow disable watch.yml`), and the Claude cloud routine `trig_01Dnn9x5u6bLK6YB1TwZiXRL` "Security Radar daily report" (`enabled: false`). Both were the pre-server design; re-enable only if the owner asks to go back to the cloud |
| Owner's memory notes | `C:\Users\atharvaPC\.claude\projects\c--Git-Projects-vectorlabs-bigcommerce-sanity\memory\security-radar.md` (this work started inside the vectorlabs session) |

## Files that matter

| File | Role |
| --- | --- |
| `watchlist.json` | The only place scope lives. `scan` ("reported" today, or "all"), `report.projects` (repo → display name, the ten reported projects), `branches`, `exclude`, `tooling`, `repos[]` (every lockfile discovery found, 86 rows across 66 repos), `feeds[]` |
| `watch.mjs` | The scan. Flags `--dry-run` (writes report.json only), `--forget id,…`. Budgets GitHub requests (leaves 150, defers the rest), writes caches before building the report |
| `src/scope.mjs` | Picks the watchlist rows for the scan mode |
| `src/report.mjs` | `buildReport` → report.json schema 3: `status`, `summary`, `projects[]` (per repo+branch, worst first, `appStatus` ignores tooling), `advisories[]` (distinct, `hits[]` only for critical/high), `apps[]` (per lockfile per branch: `open[]`, `upgrades[]` with `transitive`, `notes[]`, `command`) |
| `src/slack.mjs` | Builds every Slack message from report.json. `buildMessages(report, { projects, narrative, only })`. Pure; tested |
| `scripts/slack.mjs` | Posts them. `--dry-run`, `--only <project>`, `--narrative-file` |
| `scripts/store.mjs` | Loads one day's report into MySQL; idempotent per date |
| `scripts/discover.mjs` | Walks the org (trees API, not code search, which misses big lockfiles) and rewrites `watchlist.repos` |
| `server/daily.sh`, `server/install.sh`, `server/narrative.prompt.md`, `server/schema.sql` | The server run, its installer, Claude's prompt, the tables |
| `state.json`, `packages.json`, `report.json` | Caches and output. Still tracked in git (see Next steps); on the server they are the live copies and must never be overwritten by a pull |
| `test/` | `npm test`: 31 tests, must be `fail 0` before any commit. The commit gate was added after a chain once committed with two failing tests |

## Decisions, with the reasons

1. **Repository advisories first, OSV second.** Repo advisories are same-minute; OSV adds the
   reviewed set and MAL records. An advisory present in a repo but not in OSV is tagged `early`.
2. **Everything on the server, server is the only copy.** Owner's choice 2026-10-29 over GitHub
   Actions + cloud routine, to stop depending on GitHub for state and on a cloud sandbox for
   posting. Consequence: a `git pull` on the server collides with the three cache files (see
   Next steps for the fix and the workaround).
3. **Slack messages are built in code; Claude writes only the opening paragraph.** The
   Claude-built tables came out broken in the channel. Tables are now Slack native `table`
   blocks, which the webhook accepts (tested). Claude's paragraph is optional: if `claude -p`
   fails, the messages still go out without it.
4. **Report only Next.js, Sanity and BigCommerce projects.** Detected from direct dependencies
   (`next`, `sanity`/`@sanity/*`, `@bigcommerce/*`) and then edited by the owner: ten projects,
   names fixed by the owner (Athens BioSciences, Boston BioProducts, Catalent, Curator24,
   Cytoskeleton, Mission Bio, RayBiotech, SI Open Design, SouthernBiotech, VectorLabs).
   athens-b2b-bigcommerce, pivotpoint-sanity, sanofi-fabry-body-tour-app, strelis-sanity were
   removed by the owner. WordPress, Magento, Drupal and tooling lockfiles are out.
5. **Scan only what is reported** (`scan: "reported"`), 2026-10-29. Discovery still lists every
   repository so `"all"` is a one-word switch back. Measured: 20 lockfile rows instead of 86,
   37 apps, 3,613 distinct packages instead of 5,453.
6. **Never trim rows.** The owner asked "how will the developer know what 11 more packages
   there are?" A project that exceeds Slack's limits splits into `Name (1/2)`, `Name (2/2)`.
7. **One table per branch, in the same message** (the owner rejected one combined table with a
   Branch column). A table over 90 rows continues in a second block marked `main · continued`.
8. **Summary instead of notes.** The old notes repeated "X is not a direct dependency…" once per
   package (19 lines on Catalent). Replaced by four code-built lines: fix first, new since
   yesterday per branch, transitive packages with override targets, no fix published yet. The
   per-package fact moved into a `Direct` column (yes / no / partly).
9. **Header block and divider on every message**, because Slack stacks consecutive posts from one
   app under a single name and eighteen messages looked like one. Pull request 12.
10. **Clear projects stay in one combined message.** Owner's choice.
11. **10px/rem, 1:1 pixel rules etc. do not apply here**: that is the vectorlabs repo's CLAUDE.md,
    not this project.

## The Slack layout, as specified and approved

Posting order, one webhook call each, one second apart, retry on 429:

1. **Summary**: header "🔴 Security Radar · Thu, 29 Oct 2026"; status line (n of 10 projects
   affected, critical/high open across N advisories, oldest critical open N days, new since
   yesterday, early, MALICIOUS); Claude's paragraph; divider; "🚨 Open issues · critical and high"
   with at most 10 lines (`• 🔴 CRITICAL · <link|GHSA-id> · summary · package · open N days ·
   hits N apps in N projects · ⚡ early · NEW`); "… and N more critical/high; every project's
   message below lists its own"; divider; footer (packages, lockfiles, projects, scan time IST);
   divider. All counts cover the reported projects only.
2. **Per affected project, worst first**: header "📦 Name"; per branch a status line
   (`main` · 🔴 RED · 4 critical, 28 high) and a table with columns App, Package, Installed,
   Upgrade to, Closes, Severity (bold link to the advisory), Open ("28 days · NEW" / "· early"),
   Direct; a `clear` row for an app with nothing open; then "📝 Summary" four lines; divider.
   "App" is the lockfile folder (`root`, `web`, `sanity`, `checkout`…).
3. **Clear**: "🟢 Clear: A, B" when at least one project is affected. All clear overall is a
   single small line.

Slack limits that shape the code: 100 rows per table, 10,000 characters across all cells of a
message, 3,000 characters per section, 50 blocks per message, header text 150 characters plain.
Column `is_wrapped: false` everywhere ("columns or rows should not break").

## Current state (2026-10-29 evening IST)

- Merged: PRs 1–11. PR 11 carried the code-built messages, per-branch tables, the summary, the
  Direct column and the reported-only scan.
- Open: **PR 12** `feat/slack-headers` (header block + divider). This CLAUDE.md is on that branch.
- Server: pulled a70cee4 (PR 11 merge) after a stash dance; ran `daily.sh` by hand: scan mode
  reported, narrative 1,138 bytes, 18 of 18 Slack messages posted. The owner then asked for the
  header and divider; PR 12 is the answer and is not on the server yet.
- Cron is armed on the server for 08:00 IST. Tomorrow's run posts with whatever code is pulled.
- The owner's local `report.json` is a reported-mode dry run from this PC; not committed.
- The first MySQL load on the server happened with the `row_hash` schema (PR 10). Whether the
  history landed was to be checked with the `scans` query in README/schema.sql; not confirmed in
  chat.

## Next steps, in order

1. **Owner merges PR 12**, then on the server: `git pull && TZ=Asia/Kolkata ./server/daily.sh`.
   If the pull refuses because of `packages.json`, `report.json`, `state.json`:
   `git stash push -- packages.json report.json state.json && git pull && git checkout stash@{0} -- packages.json report.json state.json && git stash drop`.
   `git config core.fileMode false` was advised so `daily.sh`'s executable bit stops showing as a change.
2. **Stop tracking the three cache files** (`git rm --cached`, add to `.gitignore`) so server pulls
   stop colliding. Do it with explicit server commands: a commit that deletes tracked files makes
   `git pull` delete the working copies unless they are modified, so instruct the owner to copy
   them aside first or confirm they are modified. Promised to the owner as "a separate small change".
3. **Confirm the MySQL history** with the query in `server/schema.sql` comments / README; if empty,
   run `set -a; . ./.env; set +a; node scripts/store.mjs data/reports/$(TZ=Asia/Kolkata date +%F).json`.
4. **Watch the first unattended cron run** (08:00 IST): `logs/cron.log` and `logs/YYYY-MM-DD.log`.
5. Possible follow-ups the owner has not asked for yet, do not start them unasked: rename the
   App column to Folder; drop SI Open Design if it turns out internal; a `scan: "all"` run on
   demand; stale Next 12 comments nowhere here (that is vectorlabs).

## Commands

```bash
npm test                                            # 31 tests, gate for every commit
GITHUB_TOKEN=$(gh auth token) node watch.mjs --dry-run   # local scan, writes report.json only
node scripts/slack.mjs report.json --dry-run        # print payloads, post nothing
node scripts/slack.mjs report.json --only Catalent  # post one project (needs SLACK_WEBHOOK_URL)
npm run discover -- --dry-run                       # what the watchlist would become
TZ=Asia/Kolkata ./server/daily.sh                   # on the server: the whole day by hand (not twice within an hour)
```

## Traps already paid for

- Classic PAT only; fine-grained is stuck in org approval. PowerShell `curl` is an alias:
  use `curl.exe` or `gh api`.
- GitHub user token 5,000 req/h vs Actions token 1,000. A cold run polls ~2,100 repositories.
- OSV refetch storm fixed by storing `osvModified` and comparing strings. Report crash on legacy
  state entries fixed with the `asList` guard. Caches are written before the report is built.
- MySQL: six utf8mb4 text columns in a key exceed 3,072 bytes → `findings` keyed by sha1 `row_hash`.
- Bash heredocs with backticks and `$(` inside a quoted heredoc have failed to parse in this
  environment twice; write multi-line content with the Write tool to a scratch file instead.
- The Slack webhook accepts `table`, `header`, `divider`, `section` blocks and several tables per
  message (tested live). Links only in `rich_text` cells. Escape `& < >` in mrkdwn text, not in cells.
