// Reads what a lockfile has installed. Supports pnpm-lock.yaml (v6 and v9), package-lock.json and yarn.lock.
//
//   installedVersions(text, file)         Map name -> Set of every resolved version (all packages)
//   installedVersions(text, file, names)  the same, limited to `names`
//   directVersions(text, file, names?)    Map name -> Set of versions the app declares itself
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
