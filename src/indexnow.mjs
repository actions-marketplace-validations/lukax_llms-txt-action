// IndexNow (https://www.indexnow.org/documentation): tell Bing, Yandex, Seznam, Naver, Yep and others which URLs changed.
// The key must be served at https://<host>/<key>.txt (or `keyLocation`) on the same host; we check it before submitting.

import { USER_AGENT } from './llms.mjs';

export const INDEXNOW_API = 'https://api.indexnow.org/indexnow';
const KEY = /^[a-zA-Z0-9-]{8,128}$/;
/** IndexNow takes up to 10,000 URLs per request. */
const BATCH = 10_000;
const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap-index.xml', '/sitemap_index.xml'];
const MAX_SITEMAPS = 20;
const TIMEOUT = 30_000;

export class IndexNowError extends Error {}

/** `indexnow-urls`: one per line or comma-separated, resolved against the site. */
export function parseUrls(text, site) {
  return [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map((s) => new URL(s, site).href))];
}

async function get(fetch, url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
    return { status: res.status, text: res.ok ? await res.text() : '' };
  } catch (err) {
    return { status: 0, text: '', error: err.message };
  }
}

/** Throws unless the key is well formed and its key file (on the site's host) holds it. Returns the key file URL. */
export async function checkKey(fetch, { key, site, keyLocation }) {
  if (!KEY.test(key)) throw new IndexNowError('`indexnow-key` must be 8–128 letters, digits or dashes.');
  const file = new URL(keyLocation || `/${key}.txt`, site);
  if (file.host !== new URL(site).host) throw new IndexNowError(`\`indexnow-key-location\` must be on ${new URL(site).host}.`);
  const res = await get(fetch, file);
  if (res.status !== 200) throw new IndexNowError(`The IndexNow key file ${file.href} answered ${res.status || res.error}. Publish a file there containing just the key.`);
  if (res.text.trim() !== key) throw new IndexNowError(`The IndexNow key file ${file.href} doesn’t contain the key.`);
  return file.href;
}

const locs = (xml) => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));

/** Page URLs of the site's sitemap (sitemap.xml, or an index of sitemaps, one level deep). */
export async function sitemapUrls(fetch, site) {
  for (const path of SITEMAP_PATHS) {
    const res = await get(fetch, new URL(path, site));
    if (res.status !== 200 || !/<(urlset|sitemapindex)\b/i.test(res.text)) continue;
    if (!/<sitemapindex\b/i.test(res.text)) return locs(res.text);
    const urls = [];
    for (const child of locs(res.text).slice(0, MAX_SITEMAPS)) {
      const c = await get(fetch, child);
      if (c.status === 200) urls.push(...locs(c.text));
    }
    return urls;
  }
  return [];
}

/** Folders that hold pages but aren't part of their URLs. */
const ROOT_NAMES = new Set(['src', 'pages', 'app', 'routes', 'content', 'docs', 'public', 'static', 'site', 'www']);
const PAGE_FILE = /\.(md|mdx|markdown|html?|astro|svelte|vue|jsx?|tsx?|njk|liquid|hbs|rst|adoc)$/i;
/**
 * Changed repo files → the sitemap URLs they are, by path: `src/pages/docs/intro.mdx` and
 * `content/docs/intro/index.md` are `/docs/intro`; Next's `app/pricing/page.tsx` is `/pricing`. Leading folders are
 * dropped only while they're source roots (`src`, `pages`, `content`…), longest match first, so `src/lib/docs.ts`
 * is never `/docs`. Files that aren't pages (components, styles, config) match nothing: a shared change doesn't
 * resubmit the whole site.
 */
export function changedUrls(files, urls) {
  const byPath = new Map();
  for (const u of urls) {
    const p = new URL(u).pathname.replace(/\/index\.html?$|\.html?$/, '').replace(/\/+$/, '') || '/';
    byPath.set(p, [...(byPath.get(p) ?? []), u]);
  }
  const out = new Set();
  for (const file of files) {
    if (!PAGE_FILE.test(file)) continue;
    const path = file.replace(/\.[^./]+$/, '').replace(/(^|\/)(index|page|\+page|_index|README)$/i, '');
    // Dynamic segments of file-based routers match many URLs: not guessed.
    if (/[[\]]/.test(path)) continue;
    // Route groups (`(marketing)`) aren't in URLs.
    const segments = path.split('/').filter((s) => s && !/^\(.*\)$/.test(s));
    for (let i = 0; i <= segments.length; i++) {
      if (i > 0 && !ROOT_NAMES.has(segments[i - 1].toLowerCase())) break;
      const hits = byPath.get(`/${segments.slice(i).join('/')}`);
      if (hits) {
        for (const u of hits) out.add(u);
        break;
      }
    }
  }
  return [...out];
}

/** POST the URLs (same host as `site` only) in batches. Returns how many were accepted. */
export async function submit(fetch, { key, site, keyLocation, urls, endpoint = INDEXNOW_API }) {
  const host = new URL(site).host;
  const list = urls.filter((u) => new URL(u).host === host);
  let sent = 0;
  for (let i = 0; i < list.length; i += BATCH) {
    const urlList = list.slice(i, i + BATCH);
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': USER_AGENT },
        body: JSON.stringify({ host, key, ...(keyLocation ? { keyLocation } : {}), urlList }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch (err) {
      throw new IndexNowError(`Couldn’t reach IndexNow: ${err.message}`);
    }
    if (res.status !== 200 && res.status !== 202) {
      const why = { 400: 'bad request', 403: 'the key isn’t valid for this host (key file not found or wrong)', 422: 'URLs don’t belong to the host or the key doesn’t match', 429: 'too many requests' }[res.status];
      throw new IndexNowError(`IndexNow answered ${res.status}${why ? `: ${why}` : ''}.`);
    }
    sent += urlList.length;
  }
  return { sent, dropped: urls.length - list.length };
}
