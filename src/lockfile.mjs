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
