// Minimal RSS 2.0 / Atom reader. Returns [{ title, link, date }], newest first.

const decode = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

const pick = (block, tag) => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? decode(m[1]) : null;
};

export function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  for (const block of blocks) {
    const atomLink = /<link[^>]*href="([^"]+)"/i.exec(block)?.[1];
    const link = atomLink ?? pick(block, 'link');
    const date = pick(block, 'pubDate') ?? pick(block, 'published') ?? pick(block, 'updated');
    items.push({
      title: pick(block, 'title') ?? '(untitled)',
      link: decode(link),
      date: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
    });
  }
  return items.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

export async function fetchFeed(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'security-watch' } });
  if (!res.ok) throw new Error(`feed ${url} -> ${res.status}`);
  return parseFeed(await res.text());
}
