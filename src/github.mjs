const API = 'https://api.github.com';

export function makeClient({ token, userAgent = 'security-radar' } = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': userAgent,
  };
  if (token) headers.authorization = `Bearer ${token}`;

  async function request(path, { accept, method = 'GET', body, raw = false, etag } = {}) {
    const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
      method,
      headers: {
        ...headers,
        ...(accept ? { accept } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(etag ? { 'if-none-match': etag } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 304) return { notModified: true, etag };
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`GitHub ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
      err.status = res.status;
      err.retryAfter = Number(res.headers.get('retry-after') ?? 0);
      throw err;
    }
    const data = raw ? await res.text() : await res.json();
    return etag !== undefined ? { data, etag: res.headers.get('etag') } : data;
  }

  return {
    // Repository-level advisories: published by the maintainer, same minute as the release.
    // With `etag`, a 304 answer costs no rate limit and returns { notModified: true }.
    repoAdvisories: (repo, etag) =>
      request(`/repos/${repo}/security-advisories?state=published&per_page=100&sort=published&direction=desc`, { etag: etag ?? null }),
    // Global GitHub Advisory Database: complete, but reviewed a week or so later.
    globalAdvisories: (pkg) =>
      request(`/advisories?affects=${encodeURIComponent(pkg)}&ecosystem=npm&per_page=100&sort=published&direction=desc`),
    fileText: (repo, path, ref) =>
      request(`/repos/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, {
        accept: 'application/vnd.github.raw+json',
        raw: true,
      }),
    repoMeta: (repo) => request(`/repos/${repo}`),
    tree: (repo, ref) => request(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`),
    orgRepos: async (org) => {
      const all = [];
      for (let page = 1; ; page++) {
        const batch = await request(`/orgs/${org}/repos?per_page=100&type=all&page=${page}`);
        if (!batch.length) break;
        all.push(...batch);
      }
      return all;
    },
    createIssue: (repo, { title, body, labels }) =>
      request(`/repos/${repo}/issues`, { method: 'POST', body: { title, body, labels } }),
    rateLimit: () => request('/rate_limit'),
  };
}

// True when the exact version is on the npm registry, false when it is not, null when the check failed.
export async function npmPublished(name, version) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}/${encodeURIComponent(version)}`, {
      method: 'HEAD',
      headers: { 'user-agent': 'security-radar' },
    });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

// Normalise either endpoint's shape to one record. `watchedNames` (optional) keeps only those packages.
export function normalise(raw, source, watchedNames = null) {
  const packages = (raw.vulnerabilities ?? [])
    .filter((v) => (v.package?.ecosystem ?? '').toLowerCase() === 'npm')
    .map((v) => ({
      name: v.package.name,
      range: v.vulnerable_version_range ?? null,
      // Repository advisories say patched_versions; the global database says first_patched_version.
      fixed: v.patched_versions || v.first_patched_version || null,
    }));
  const watched = watchedNames ? packages.filter((p) => watchedNames.has(p.name)) : packages;
  return {
    id: raw.ghsa_id,
    cve: raw.cve_id ?? null,
    summary: raw.summary ?? '',
    severity: (raw.severity ?? 'unknown').toLowerCase(),
    published_at: raw.published_at,
    updated_at: raw.updated_at ?? raw.published_at,
    url: raw.html_url ?? `https://github.com/advisories/${raw.ghsa_id}`,
    packages: watched.length ? watched : packages,
    source,
  };
}
