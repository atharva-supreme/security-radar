// npm registry: which GitHub repository publishes a package's advisories, and whether a version exists.

const headers = { 'user-agent': 'security-radar', accept: 'application/json' };

// "owner/repo" from a package's repository field, or null when it is not on GitHub.
export function githubRepoFrom(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  if (!url) return null;
  const m = /github\.com[/:]([^/#?\s]+)\/([^/#?\s]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Looks the package up on the registry. Returns { repo, checkedAt } with repo "owner/repo" or null.
export async function repoOf(name) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}/latest`, { headers });
  if (res.status === 404) return { repo: null, checkedAt: new Date().toISOString(), missing: true };
  if (!res.ok) throw new Error(`npm GET ${name}/latest -> ${res.status}`);
  const json = await res.json();
  return { repo: githubRepoFrom(json.repository), checkedAt: new Date().toISOString() };
}

// True when the exact version is on the registry, false when it is not, null when the check failed.
export async function published(name, version) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}/${encodeURIComponent(version)}`, { method: 'HEAD', headers });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

// Runs `fn` over `items` with at most `limit` in flight. Returns results in order; errors become { error }.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e }; }
    }
  }));
  return out;
}
