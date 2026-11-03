// Reads what a lockfile has installed. Supports pnpm-lock.yaml (v6 and v9), package-lock.json and yarn.lock.
//
//   installedVersions(text, file)         Map name -> Set of every resolved version (all packages)
//   installedVersions(text, file, names)  the same, limited to `names`
//   directVersions(text, file, names?)    Map name -> Set of versions the app declares itself
//   dependencyGraph(text, file)           prod/dev reachability and "who pulls this in" (pnpm, npm)
//   declaredNode({ packageJsonText })     the Node.js version the app declares, or null

function collector(names) {
  const wanted = names ? new Set(names) : null;
  const found = new Map(names ? names.map((n) => [n, new Set()]) : []);
  const add = (name, version) => {
    if (!version || (wanted && !wanted.has(name))) return;
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(version.replace(/^v/, ''));
  };
  return { found, add };
}

export function installedVersions(text, filename, names = null) {
  const { found, add } = collector(names);

  if (/package-lock\.json$/.test(filename)) {
    const json = JSON.parse(text);
    for (const [key, entry] of Object.entries(json.packages ?? {})) {
      const m = /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (m && !entry.link) add(m[1], entry.version);
    }
    // lockfileVersion 1 has no "packages"; walk "dependencies" instead.
    if (!json.packages && json.dependencies) {
      const walk = (deps) => { for (const [name, d] of Object.entries(deps)) { add(name, d.version); if (d.dependencies) walk(d.dependencies); } };
      walk(json.dependencies);
    }
    return found;
  }

  if (/pnpm-lock\.ya?ml$/.test(filename)) {
    // packages: section, entries indented two spaces:
    //   /next@16.2.12:             (lockfile v6)
    //   next@16.2.12:              (lockfile v9)
    //   '@sanity/client@7.26.2':   (scoped, either)
    //   next@16.2.12(react@19.2.7): (peer suffix)
    const start = text.search(/^packages:/m);
    const body = start >= 0 ? text.slice(start) : text;
    const end = body.search(/^snapshots:/m);
    const section = end >= 0 ? body.slice(0, end) : body;
    const re = /^  '?\/?((?:@[^/@'\s]+\/)?[^@'\s/]+)@([^\s'(:]+)/gm;
    let m;
    while ((m = re.exec(section))) add(m[1], m[2]);
    return found;
  }

  if (/yarn\.lock$/.test(filename)) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\s/.test(lines[i]) || !lines[i].trim() || lines[i].startsWith('#')) continue;
      const header = /^"?((?:@[^/@"\s]+\/)?[^@"\s/]+)@/.exec(lines[i]);
      if (!header) continue;
      for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) {
        const v = /^\s+version:?\s+"?([^"\s]+)"?/.exec(lines[j]);
        if (v) { add(header[1], v[1]); break; }
      }
    }
    return found;
  }

  throw new Error(`installedVersions: unsupported lockfile ${filename}`);
}

// Versions the app declares itself (its own package.json), as opposed to versions pulled in by
// another package. An installed version that is not direct cannot be moved by `pnpm up <name>`:
// it needs an override, or an upgrade of whatever depends on it.
// pnpm: the importers section. package-lock: the root package's dependency lists. yarn.lock does
// not record this, so it returns null (unknown).
export function directVersions(text, filename, names = null) {
  const { found, add } = collector(names);

  if (/pnpm-lock\.ya?ml$/.test(filename)) {
    const start = text.search(/^importers:/m);
    if (start < 0) return found;
    const rest = text.slice(start + 'importers:'.length);
    const next = rest.search(/^[A-Za-z]/m);
    const section = next < 0 ? rest : rest.slice(0, next);
    const re = /^ {6}'?((?:@[^/'\s]+\/)?[^'\s:]+)'?:\n {8}specifier: [^\n]*\n {8}version: ([^\s(]+)/gm;
    let m;
    while ((m = re.exec(section))) add(m[1], m[2]);
    return found;
  }

  if (/package-lock\.json$/.test(filename)) {
    const json = JSON.parse(text);
    const root = json.packages?.[''] ?? json;
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = root[group] ?? {};
      for (const name of Object.keys(deps)) {
        const v = json.packages?.[`node_modules/${name}`]?.version ?? (typeof deps[name] === 'object' ? deps[name].version : null);
        add(name, v);
      }
    }
    return found;
  }

  if (/yarn\.lock$/.test(filename)) return null;
  throw new Error(`directVersions: unsupported lockfile ${filename}`);
}

// ---------- dependency graph: is a package deployed, and which declared dependency pulls it in ----------
//
// dependencyGraph(text, file) -> {
//   kind                 'pnpm' | 'npm' | null (yarn.lock records no graph)
//   importers            the workspace projects the lockfile covers (".", "studio", "web/core" ...)
//   isProd(name, ver)    true  = reachable from a dependencies/optionalDependencies root (ships)
//                        false = reachable from devDependencies only (never deployed)
//                        null  = unknown (yarn, or the version is not in the graph)
//   via(name, ver)       { direct, importer, dev, depth } for the nearest declared dependency that
//                        pulls it in, preferring a production path; null when unknown

const PROD_GROUPS = new Set(['dependencies', 'optionalDependencies']);
const DEV_GROUPS = new Set(['devDependencies']);
const unknownGraph = () => ({ kind: null, importers: [], isProd: () => null, via: () => null });

function graphOf({ kind, roots, children, parents, keysByName, nameOf }) {
  // roots: Map key -> [{ importer, group }]; children/parents: Map key -> Set key
  const reach = (groups) => {
    const seen = new Set();
    const queue = [...roots].filter(([, rs]) => rs.some((r) => groups.has(r.group))).map(([k]) => k);
    while (queue.length) {
      const k = queue.pop();
      if (seen.has(k)) continue;
      seen.add(k);
      for (const c of children.get(k) ?? []) if (!seen.has(c)) queue.push(c);
    }
    return seen;
  };
  const prod = reach(PROD_GROUPS);
  const dev = reach(DEV_GROUPS);
  const keysFor = (name, version) => (keysByName.get(name) ?? []).filter((k) => k.version === version).map((k) => k.key);

  return {
    kind,
    importers: [...new Set([...roots.values()].flat().map((r) => r.importer))],
    isProd(name, version) {
      const keys = keysFor(name, version);
      if (!keys.length) return null;
      if (keys.some((k) => prod.has(k))) return true;
      if (keys.some((k) => dev.has(k))) return false;
      return null;
    },
    via(name, version) {
      const starts = keysFor(name, version);
      if (!starts.length) return null;
      let best = null;
      // Breadth-first up the parents: the first root met is the shortest chain. A production root
      // beats a dev root even when the dev root is nearer.
      const seen = new Set(starts);
      let frontier = starts.map((k) => ({ k, depth: 0 }));
      while (frontier.length) {
        const next = [];
        for (const { k, depth } of frontier) {
          for (const r of roots.get(k) ?? []) {
            const cand = { direct: nameOf(k), importer: r.importer, dev: !PROD_GROUPS.has(r.group), depth };
            if (!best || (best.dev && !cand.dev)) best = cand;
          }
          for (const p of parents.get(k) ?? []) if (!seen.has(p)) { seen.add(p); next.push({ k: p, depth: depth + 1 }); }
        }
        if (best && !best.dev) break;
        frontier = next;
      }
      return best;
    },
  };
}

function pnpmGraph(text) {
  const roots = new Map(), children = new Map(), parents = new Map(), keysByName = new Map();
  const registered = new Set();
  const link = (parent, child) => {
    (children.get(parent) ?? children.set(parent, new Set()).get(parent)).add(child);
    (parents.get(child) ?? parents.set(child, new Set()).get(child)).add(parent);
  };
  const unquote = (s) => s.replace(/^'(.*)'$/, '$1');
  // "/next@16.2.12(react@19.2.7)" -> { key: "next@16.2.12" }; null for links and unparsable values
  const keyOf = (raw) => {
    const s = unquote(raw.trim()).replace(/^\//, '').replace(/\(.*$/, '');
    const m = /^((?:@[^/@]+\/)?[^@]+)@(.+)$/.exec(s);
    return m && !/^(link|file|workspace):/.test(m[2]) ? { key: `${m[1]}@${m[2]}`, name: m[1], version: m[2] } : null;
  };
  // dependency value: "16.2.12(react@19.2.7)", "link:../x", or an alias "string-width@4.2.3"
  const childKey = (name, value) => {
    const v = unquote(value.trim()).replace(/\(.*$/, '');
    if (/^(link|file|workspace):/.test(v)) return null;
    const alias = /^((?:@[^/@]+\/)?[^@]+)@(\d.*)$/.exec(v);
    if (alias) return { key: `${alias[1]}@${alias[2]}`, name: alias[1], version: alias[2] };
    return /^\d/.test(v) ? { key: `${name}@${v}`, name, version: v } : null;
  };
  const reg = (k) => {
    if (!k || registered.has(k.key)) return k;
    registered.add(k.key);
    (keysByName.get(k.name) ?? keysByName.set(k.name, []).get(k.name)).push({ key: k.key, version: k.version });
    return k;
  };
  const addRoot = (k, importer, group) => { if (k) { reg(k); (roots.get(k.key) ?? roots.set(k.key, []).get(k.key)).push({ importer, group }); } };
  const TOP_GROUPS = new Set(['dependencies', 'devDependencies', 'optionalDependencies']);

  let section = null, importer = null, group = null, entry = null, depGroup = null, pendingDep = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.startsWith('#')) continue;
    const indent = line.search(/\S/);
    const body = line.trim();
    if (indent === 0) {
      section = body.replace(/:.*$/, '');
      importer = group = entry = depGroup = pendingDep = null;
      // single-project v6 files list dependencies at the top level: treat them as importer "."
      if (TOP_GROUPS.has(section)) { importer = '.'; group = section; }
      continue;
    }
    if (section === 'importers') {
      if (indent === 2) { importer = unquote(body.replace(/:$/, '')); group = null; continue; }
      if (indent === 4) { group = body.replace(/:$/, ''); pendingDep = null; continue; }
      if (indent === 6 && group) { pendingDep = unquote(body.replace(/:$/, '')); continue; }
      if (indent === 8 && pendingDep && body.startsWith('version:')) addRoot(childKey(pendingDep, body.slice('version:'.length)), importer, group);
      continue;
    }
    if (TOP_GROUPS.has(section)) {
      // v6 single project: "  next:\n    specifier: ...\n    version: 16.2.12(...)"
      if (indent === 2) { pendingDep = unquote(body.replace(/:$/, '')); continue; }
      if (indent === 4 && pendingDep && body.startsWith('version:')) addRoot(childKey(pendingDep, body.slice('version:'.length)), '.', group);
      continue;
    }
    if (section === 'packages' || section === 'snapshots') {
      if (indent === 2) { entry = reg(keyOf(body.replace(/:$/, ''))); depGroup = null; continue; }
      if (!entry) continue;
      if (indent === 4) { const g = body.replace(/:$/, ''); depGroup = PROD_GROUPS.has(g) ? g : null; continue; }
      if (indent === 6 && depGroup) {
        const m = /^('?[^':]+'?):\s*(.+)$/.exec(body);
        if (!m) continue;
        const c = reg(childKey(unquote(m[1]), m[2]));
        if (c) link(entry.key, c.key);
      }
    }
  }
  return graphOf({ kind: 'pnpm', roots, children, parents, keysByName, nameOf: (k) => k.replace(/@[^@]+$/, '') });
}

function npmGraph(json) {
  const nodes = json.packages ?? {};
  const nameOf = (key) => key.replace(/^.*node_modules\//, '');
  const isRoot = (key) => key === '' || !key.includes('node_modules/');
  const roots = new Map(), children = new Map(), parents = new Map(), keysByName = new Map();
  const link = (parent, child) => {
    (children.get(parent) ?? children.set(parent, new Set()).get(parent)).add(child);
    (parents.get(child) ?? parents.set(child, new Set()).get(child)).add(parent);
  };
  // Node resolution: nearest node_modules folder walking up from the requiring package.
  const resolve = (from, name) => {
    let base = from;
    for (;;) {
      const c = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
      if (nodes[c]) return c;
      if (!base) return null;
      const i = base.lastIndexOf('/node_modules/');
      base = i >= 0 ? base.slice(0, i) : '';
    }
  };
  for (const [key, entry] of Object.entries(nodes)) {
    if (entry.link) continue;
    if (!isRoot(key)) (keysByName.get(nameOf(key)) ?? keysByName.set(nameOf(key), []).get(nameOf(key))).push({ key, version: entry.version });
    const groups = isRoot(key) ? ['dependencies', 'optionalDependencies', 'devDependencies'] : ['dependencies', 'optionalDependencies'];
    for (const group of groups) {
      for (const name of Object.keys(entry[group] ?? {})) {
        const target = resolve(key, name);
        if (!target) continue;
        if (isRoot(key)) (roots.get(target) ?? roots.set(target, []).get(target)).push({ importer: key || '.', group });
        else link(key, target);
      }
    }
  }
  const g = graphOf({ kind: 'npm', roots, children, parents, keysByName, nameOf });
  // npm records dev-only per node; trust that flag first and use reachability only as a fallback.
  const reachable = g.isProd;
  g.isProd = (name, version) => {
    const keys = (keysByName.get(name) ?? []).filter((k) => k.version === version);
    if (!keys.length) return null;
    if (keys.some((k) => nodes[k.key].dev === false || (nodes[k.key].dev === undefined && reachable(name, version) === true))) return true;
    if (keys.every((k) => nodes[k.key].dev === true)) return false;
    return reachable(name, version);
  };
  return g;
}

export function dependencyGraph(text, filename) {
  try {
    if (/pnpm-lock\.ya?ml$/.test(filename)) return pnpmGraph(text);
    if (/package-lock\.json$/.test(filename)) {
      const json = JSON.parse(text);
      return json.packages ? npmGraph(json) : unknownGraph();
    }
  } catch { /* the graph is a refinement: fall back to unknown rather than fail the scan */ }
  return unknownGraph();
}

// Declared Node.js version for a repo: package.json engines.node, else .nvmrc / .node-version.
export function declaredNode({ packageJsonText, nvmrcText }) {
  if (packageJsonText) {
    try {
      const engines = JSON.parse(packageJsonText).engines?.node;
      if (engines) return String(engines).trim();
    } catch { /* fall through */ }
  }
  if (nvmrcText) return nvmrcText.trim();
  return null;
}

// What a lockfile recorded for each package.json it covers: { overrides, importers: { dir: { name: specifier } } }.
// Used only to compare against package.json; versions always come from installedVersions.
export function lockfileSpecs(text, filename) {
  const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, '');
  if (/pnpm-lock\.ya?ml$/.test(filename)) {
    const overrides = new Set();
    const importers = {};
    const lines = text.split(/\r?\n/);
    let block = null, dir = null, section = null, dep = null;
    for (const l of lines) {
      if (l && !l.startsWith(' ')) { block = /^(overrides|importers):/.exec(l)?.[1] ?? null; continue; }
      if (block === 'overrides') {
        const m = /^  (.+?):\s/.exec(l);
        // "uuid", "js-yaml@3.13.1" and "a>b@1" all override the last named package.
        if (m) overrides.add(/^(@?[^@]+)/.exec(unquote(m[1]).split('>').pop())?.[1]);
      } else if (block === 'importers') {
        let m;
        if ((m = /^  (\S.*):\s*$/.exec(l))) { dir = unquote(m[1]); importers[dir] = {}; section = null; }
        else if ((m = /^    (dependencies|devDependencies|optionalDependencies):\s*$/.exec(l))) section = m[1];
        else if ((m = /^      (\S.*):\s*$/.exec(l))) dep = unquote(m[1]);
        else if ((m = /^        specifier:\s*(.*)$/.exec(l)) && dir !== null && section) importers[dir][dep] = unquote(m[1]);
      }
    }
    return { overrides, importers };
  }
  if (/package-lock\.json$/.test(filename)) {
    const json = JSON.parse(text);
    const importers = {};
    for (const [path, p] of Object.entries(json.packages ?? {})) {
      if (path.includes('node_modules')) continue;
      importers[path === '' ? '.' : path] = { ...p.dependencies, ...p.devDependencies, ...p.optionalDependencies };
    }
    return { overrides: new Set(), importers };
  }
  return null;
}

// Every dependency a package.json declares that its lockfile records differently or not at all.
// A pnpm override legitimately rewrites the recorded specifier, so overridden packages are skipped.
// manifests: { 'web/core/package.json': { dependencies, devDependencies, optionalDependencies } }.
export function driftOf({ lockText, lockPath, manifests }) {
  const specs = lockfileSpecs(lockText, lockPath);
  if (!specs) return [];
  const base = lockPath.includes('/') ? lockPath.slice(0, lockPath.lastIndexOf('/')) : '';
  const out = [];
  for (const [dir, recorded] of Object.entries(specs.importers)) {
    const rel = [base, dir === '.' ? '' : dir.replace(/^\.\//, '')].filter(Boolean).join('/');
    const manifest = rel ? `${rel}/package.json` : 'package.json';
    const pkg = manifests[manifest];
    if (!pkg) continue;
    const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
    for (const [name, spec] of Object.entries(declared)) {
      if (specs.overrides.has(name)) continue;
      if (!(name in recorded)) out.push({ lockfile: lockPath, manifest, package: name, declared: spec, locked: null });
      else if (recorded[name] !== spec) out.push({ lockfile: lockPath, manifest, package: name, declared: spec, locked: recorded[name] });
    }
  }
  return out;
}
