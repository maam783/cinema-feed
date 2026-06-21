// Shared utilities: polite fetch with retry/timeout, bounded concurrency, German date parsing.

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Global polite throttle: space out request *starts* regardless of concurrency.
const REQ_GAP_MS = +(process.env.REQ_GAP_MS || 180);
let _nextSlot = 0;
async function gate() {
  const now = Date.now();
  const wait = Math.max(0, _nextSlot - now);
  _nextSlot = Math.max(now, _nextSlot) + REQ_GAP_MS;
  if (wait) await sleep(wait);
}

/** Fetch text with throttle, timeout, and 429/5xx backoff. Returns null on permanent failure. */
export async function fetchText(url, { tries = 4, timeoutMs = 15000 } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    await gate();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'de-DE,de;q=0.9',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: 'https://www.berlin.de/kino/',
        },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      clearTimeout(t);
      if (res.status === 404 || res.status === 410) return null; // gone — don't retry
      if (res.status === 429 || res.status >= 500) {
        const ra = +(res.headers.get('retry-after') || 0);
        const backoff = ra ? ra * 1000 : 1500 * 2 ** attempt + Math.floor(Math.random() * 500);
        if (attempt === tries - 1) {
          console.warn(`  give up (${res.status}) ${url}`);
          return null;
        }
        await sleep(Math.min(backoff, 30000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      clearTimeout(t);
      if (attempt === tries - 1) {
        console.warn(`  fetch failed (${url}): ${err.message}`);
        return null;
      }
      await sleep(600 * 2 ** attempt + Math.floor(Math.random() * 300));
    }
  }
  return null;
}

/** Fetch + parse JSON, null on failure. */
export async function fetchJson(url, opts = {}) {
  const txt = await fetchText(url, opts);
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/** Run `fn` over items with bounded concurrency; preserves order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const MONTHS = {
  jan: 1, feb: 2, mär: 3, maerz: 3, mrz: 3, apr: 4, mai: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dez: 12,
};

/** "18.06.26" / "18.06.2026" / "So, 21.06.26" → "2026-06-18" (ISO date) or null. */
export function parseGermanDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (!m) return null;
  let [, d, mo, y] = m;
  d = +d; mo = +mo; y = +y;
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "18. Juni 2026" → ISO date (for vorschau/wikidata text). */
export function parseGermanLongDate(s) {
  if (!s) return null;
  const m = String(s).toLowerCase().match(/(\d{1,2})\.?\s*([a-zä]{3,})\.?\s*(\d{4})/);
  if (!m) return null;
  const d = +m[1];
  const mo = MONTHS[m[2].slice(0, 3)] ?? MONTHS[m[2]];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Collapse whitespace, decode a few common entities. */
export function clean(s) {
  if (!s) return '';
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ')
    .trim();
}

export { sleep };
