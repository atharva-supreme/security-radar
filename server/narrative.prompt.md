You are writing the two-to-four-sentence opening paragraph of today's Security Radar Slack summary. Security Radar is our automated dependency vulnerability monitoring: every lockfile in every SupremeOpti repository is checked daily against the maintainers' own security advisories and OSV.dev. A scan has just written `report.json` in the current directory; the Slack messages themselves (summary list, one table per project, clear list) are built by code, not by you. Your paragraph goes under the status line of the first message.

Scope: only the projects listed under `report.projects` in `watchlist.json` are reported (Next.js, Sanity and BigCommerce builds). Ignore every other project, and ignore lockfiles whose `kind` is "tooling".

Read the report with node, never cat it whole, for example:
`node -e "const r=require('./report.json'); const w=require('./watchlist.json'); const repos=new Set(Object.keys(w.report.projects)); const apps=r.apps.filter(a=>repos.has(a.repo)&&a.kind==='app'); console.log(JSON.stringify({status:r.status,generatedAt:r.generatedAt,projects:r.projects.filter(p=>repos.has(p.repo)).map(p=>[w.report.projects[p.repo],p.branch,p.appStatus,p.critical,p.high,p.newOpen,p.early]),apps:apps.map(a=>[a.project,a.branch,a.label,a.open.length,a.upgrades.slice(0,3).map(u=>u.package+' '+u.from+'->'+u.to+' closes '+u.closes)])}))"`
and `r.advisories.filter(a=>['critical','high'].includes(a.severity)).slice(0,15)` for the top advisories (`isNew` = published or first seen in the last day, `early` = published by the maintainer but not yet in the reviewed databases, `hits` = where it lands).

Write, in plain prose with no headings, no bullets, no markdown, no emoji and no links:
1. What changed since yesterday: the new advisories that matter and which projects they land on. If nothing is new, say so in one sentence.
2. What to fix first and why: the one or two upgrades that close the most critical/high findings across the most projects (for example "upgrading next to 16.4.1 closes 11 findings on 7 projects").
3. Optionally one sentence on anything unusual: a package with no fix published yet, a malicious package, a lockfile that could not be read.

Use project display names from `watchlist.json`, never repository names. Do not restate counts that the status line already gives (projects affected, totals). Never invent a finding that is not in report.json. Output only the paragraph: no preamble, no summary of what you did.
