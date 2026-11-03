// Minimal semver: enough to evaluate the comparator ranges GitHub advisories use.
// The global database writes ">= 16.0.0, <= 16.4.0"; repository advisories are typed by
// maintainers and arrive as ">=16.0.0 <= 16.4.0" or ">= 16.0.0" with no upper bound at all.
// Deliberately dependency-free: this script audits other people's dependencies.

export function parse(input) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(input).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

export function compare(a, b) {
  const x = typeof a === 'string' ? parse(a) : a;
  const y = typeof b === 'string' ? parse(b) : b;
  if (!x || !y) throw new Error(`compare: unparsable version ${a} / ${b}`);
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  if (x.pre && y.pre && x.pre !== y.pre) return x.pre < y.pre ? -1 : 1;
  return 0;
}

function pad(v) {
  const [core, ...pre] = v.split('-');
  const nums = core.split('.');
  while (nums.length < 3) nums.push('0');
  return nums.join('.') + (pre.length ? `-${pre.join('-')}` : '');
}

// ">=16.0.0 <= 16.4.0" or ">= 16.0.0, <= 16.4.0" -> [{ op: '>=', version: '16.0.0' }, { op: '<=', version: '16.4.0' }]
export function comparators(range) {
  if (!range) return [];
  const out = [];
  const re = /(>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)/g;
  let m;
  while ((m = re.exec(String(range)))) out.push({ op: m[1] || '=', version: pad(m[2]) });
  return out;
}

export function normaliseRange(range) {
  const cs = comparators(range);
  return cs.length ? cs.map((c) => `${c.op} ${c.version}`).join(', ') : range ?? null;
}

export function satisfies(version, range) {
  const v = parse(version);
  const cs = comparators(range);
  if (!v || !cs.length) return false;
  return cs.every(({ op, version: target }) => {
    const c = compare(v, target);
    switch (op) {
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '<': return c < 0;
      default: return c === 0;
    }
  });
}

export const hasUpperBound = (range) => comparators(range).some((c) => c.op === '<' || c.op === '<=');
export const upperBound = (range) => comparators(range).find((c) => c.op === '<' || c.op === '<=') ?? null;
export const lowerBounds = (range) => comparators(range).filter((c) => c.op === '>' || c.op === '>=');

// First thing that looks like a full version inside a free-text "fixed" string, or null.
// "16.4.1" -> "16.4.1"; "16.3.?" -> null; "15.5.28, 16.4.1" -> "15.5.28".
export function parseableVersion(text) {
  const m = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(String(text ?? ''));
  return m ? m[0] : null;
}

// Every full version inside a "fixed" field, which may be a string ("15.5.28, 16.4.1", "16.3.?"),
// an array (OSV events) or null. Deduplicated and sorted ascending.
export function versionsIn(text) {
  const items = Array.isArray(text) ? text : [text];
  const out = new Set();
  for (const item of items) {
    for (const m of String(item ?? '').matchAll(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g)) out.add(m[0]);
  }
  return [...out].sort(compare);
}

// The version line an install sits on: its major, or "0.minor" for 0.x packages, where every minor
// is a breaking release by convention. "16.3.5" -> "16"; "0.35.4" -> "0.35".
export function lineOf(version) {
  const p = parse(version);
  if (!p) return null;
  return p.major === 0 ? `0.${p.minor}` : String(p.major);
}
export const sameLine = (a, b) => lineOf(a) !== null && lineOf(a) === lineOf(b);
export const isPrerelease = (version) => Boolean(parse(version)?.pre);

const stableAbove = (fixes, installed) =>
  parse(installed) ? versionsIn(fixes).filter((f) => !isPrerelease(f) && compare(f, installed) > 0) : [];

// The upgrade target for one installed version: the lowest stable fix above it on the same line.
// Never a downgrade, never a pre-release, never another major. Null when the line has no fix.
export function lineFix(fixes, installed) {
  return stableAbove(fixes, installed).find((f) => sameLine(f, installed)) ?? null;
}

// The lowest stable fix above the installed version on any line (the cross-major fallback a
// direct dependency can take by upgrading itself). Null when nothing above exists.
export function anyFix(fixes, installed) {
  return stableAbove(fixes, installed)[0] ?? null;
}

// The lowest version a package.json dependency range can resolve to: "^0.35.5" -> 0.35.5,
// "~1.2.3" -> 1.2.3, ">=2.1.0 <3" -> 2.1.0, "^0.34.3 || ^0.35.5" -> 0.34.3 (the resolver may keep
// the lower alternative). Null for "*", "latest", tags, URLs and anything without a version.
export function minimumOf(range) {
  const alternatives = String(range ?? '').split('||').map((s) => s.trim()).filter(Boolean);
  const mins = alternatives.map((alt) => {
    if (/^(\*|latest|x)$/i.test(alt) || /[/:]/.test(alt)) return null;
    const lower = comparators(alt.replace(/[\^~]/g, '>=')).filter((c) => c.op === '>=' || c.op === '=' || c.op === '>');
    if (!lower.length) return null;
    return lower.map((c) => c.version).sort(compare)[0];
  });
  if (!mins.length || mins.some((m) => !m)) return null;
  return mins.sort(compare)[0];
}
