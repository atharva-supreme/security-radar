import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from '../src/feeds.mjs';

test('RSS 2.0 items', () => {
  const xml = `<?xml version="1.0"?><rss><channel><title>Node.js Blog: Vulnerability Reports</title>
<item><title>Wednesday, October 21, 2026 Security Releases</title><link>https://nodejs.org/en/blog/vulnerability/october-2026-security-releases</link><pubDate>Wed, 21 Oct 2026 22:00:00 GMT</pubDate></item>
<item><title><![CDATA[July 2026 Security Releases]]></title><link>https://nodejs.org/en/blog/vulnerability/july-2026-security-releases</link><pubDate>Wed, 29 Jul 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Wednesday, October 21, 2026 Security Releases');
  assert.equal(items[0].link, 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases');
  assert.equal(items[0].date, '2026-10-21T22:00:00.000Z');
  assert.equal(items[1].title, 'July 2026 Security Releases');
});

test('Atom entries with href links', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>tag:github.com,2008:Repository/70107786/v16.4.1</id><updated>2026-10-14T17:50:00Z</updated><link rel="alternate" type="text/html" href="https://github.com/vercel/next.js/releases/tag/v16.4.1"/><title>v16.4.1</title></entry>
<entry><id>x</id><updated>2026-10-07T10:00:00Z</updated><link rel="alternate" type="text/html" href="https://github.com/vercel/next.js/releases/tag/v16.3.8"/><title>v16.3.8</title></entry>
</feed>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'v16.4.1');
  assert.equal(items[0].link, 'https://github.com/vercel/next.js/releases/tag/v16.4.1');
  assert.equal(items[0].date, '2026-10-14T17:50:00.000Z');
});

test('empty feed', () => {
  assert.deepEqual(parseFeed('<rss></rss>'), []);
});
