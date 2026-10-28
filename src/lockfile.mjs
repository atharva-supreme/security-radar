// Reads the resolved versions of named packages out of a lockfile.
// Supports pnpm-lock.yaml (v6 and v9 key styles), package-lock.json and yarn.lock.

export function installedVersions(text, filename, names) {
  const wanted = new Set(names);
  const found = new Map(names.map((n) => [n, new Set()]));
  const add = (name, version) => {
    if (wanted.has(name) && version) found.get(name).add(version.replace(/^v/, ''));
  };

  if (/package-lock\.json$/.test(filename)) {
    const json = JSON.parse(text);
    for (const [key, entry] of Object.entries(json.packages ?? {})) {
      const m = /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (m) add(m[1], entry.version);
    }
    return found;
  }

  if (/pnpm-lock\.ya?ml$/.test(filename)) {
    // packages: section, entries indented two spaces:
    //   /next@16.2.12:             (lockfile v6)
    //   next@16.2.12:              (lockfile v9)
    //   '@sanity/client@7.26.2':   (scoped, either)
    //   next@16.2.12(react@19.2.7): (peer suffix)
    const re = /^  '?\/?((?:@[^/@'\s]+\/)?[^@'\s/]+)@([^\s'(:]+)/gm;
    let m;
    while ((m = re.exec(text))) add(m[1], m[2]);
    return found;
  }

  if (/yarn\.lock$/.test(filename)) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\s/.test(lines[i])) continue;
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

// Versions of the named packages that the app declares itself (its own package.json), as opposed to
// versions pulled in by another package. An installed version that is not direct cannot be moved by
// `pnpm up <name>@<version>`: it needs an override, or an upgrade of whatever depends on it.
// pnpm: the importers section. package-lock: the root package's dependency lists. yarn.lock does not
// record this, so it returns null (unknown).
export function directVersions(text, filename, names) {
  const found = new Map(names.map((n) => [n, new Set()]));
  const add = (name, version) => { if (found.has(name) && version) found.get(name).add(version.replace(/^v/, '')); };

  if (/pnpm-lock\.ya?ml$/.test(filename)) {
    const start = text.search(/^importers:/m);
    if (start < 0) return found;
    const rest = text.slice(start + 'importers:'.length);
    const next = rest.search(/^[A-Za-z]/m);
    const section = next < 0 ? rest : rest.slice(0, next);
    //       next:                       (name, scoped names quoted)
    //         specifier: 16.2.12
    //         version: 16.2.12(react@19.2.7)
    const re = /^ {6}'?((?:@[^/'\s]+\/)?[^'\s:]+)'?:\n {8}specifier: [^\n]*\n {8}version: ([^\s(]+)/gm;
    let m;
    while ((m = re.exec(section))) add(m[1], m[2]);
    return found;
  }

  if (/package-lock\.json$/.test(filename)) {
    const json = JSON.parse(text);
    const root = json.packages?.[''] ?? {};
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(root[group] ?? {})) add(name, json.packages?.[`node_modules/${name}`]?.version);
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
