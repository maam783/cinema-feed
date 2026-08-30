// Showtimes for houses berlin.de dropped from its program database (HTTP 410
// on kinodetail.php). Zoo Palast + the Yorck group vanished from film pages
// in late Aug 2026; official Yorck JSON and kinoprogramm.com still list them.
import * as cheerio from 'cheerio';
import { fetchText, clean } from './util.js';
import { showtimeKey, strip3DTitle } from './berlin.js';

const YORCK_FILME = 'https://www.yorck.de/filme';
const KP_CINEMA = (slug) => `https://www.kinoprogramm.com/kino/berlin/${slug}`;

function normName(s) {
  return clean(s)
    .toLowerCase()
    .replace(/[./]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normTitle(s) {
  return strip3DTitle(s)
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Houses we keep under their historic berlin.de ids (favorites, geo, filter). */
export const FALLBACK_CINEMAS = [
  { id: '30241', name: 'Zoo Palast', district: 'Charlottenburg', kinoprogramm: 'zoopalast-31428' },
  { id: '30151', name: 'Acud Kino', district: 'Mitte' },
  { id: '30158', name: 'Babylon Kreuzberg', district: 'Kreuzberg', yorck: 'babylon kreuzberg' },
  { id: '30162', name: 'Blauer Stern', district: 'Pankow', yorck: 'blauer stern' },
  { id: '30168', name: 'Capitol Dahlem', district: 'Zehlendorf', yorck: 'capitol dahlem' },
  { id: '30173', name: 'Cinema Paris', district: 'Charlottenburg', yorck: 'cinema paris' },
  { id: '30184', name: 'Delphi Filmpalast', district: 'Charlottenburg', yorck: 'delphi filmpalast' },
  { id: '30195', name: 'Filmtheater am Friedrichshain', district: 'Prenzlauer Berg', yorck: 'filmtheater am friedrichshain' },
  { id: '30202', name: 'Yorck/New Yorck', district: 'Kreuzberg', yorck: 'yorck' },
  { id: '30206', name: 'International', district: 'Mitte', yorck: 'kino international' },
  { id: '30208', name: 'Kant Kino', district: 'Charlottenburg', yorck: 'kant kino' },
  { id: '30224', name: 'Neues Off', district: 'Neukölln', yorck: 'neues off' },
  { id: '30227', name: 'Odeon', district: 'Schöneberg', yorck: 'odeon' },
  { id: '30228', name: 'Passage', district: 'Neukölln', yorck: 'passage' },
  { id: '30231', name: 'Rollberg Kinos', district: 'Neukölln', yorck: 'rollberg' },
  { id: '36969', name: 'Delphi LUX', district: 'Charlottenburg', yorck: 'delphi lux' },
];

const YORCK_ALIASES = {
  international: 'kino international',
  'kino international': 'kino international',
};

const yorckIndex = new Map();
for (const c of FALLBACK_CINEMAS) {
  if (!c.yorck) continue;
  yorckIndex.set(c.yorck, c);
}
yorckIndex.set('international', yorckIndex.get('kino international'));

export function cinemaForYorckName(name) {
  const key = YORCK_ALIASES[normName(name)] || normName(name);
  return yorckIndex.get(key) || null;
}

export function versionFromTokens(tokens) {
  const t = (Array.isArray(tokens) ? tokens.join(' ') : String(tokens || '')).toLowerCase();
  if (/omu|omeu|untertitel/.test(t)) return 'OmU';
  if (/ov|original/.test(t)) return 'OV';
  return 'DE';
}

export function is3DTokens(tokens) {
  const t = (Array.isArray(tokens) ? tokens.join(' ') : String(tokens || '')).toLowerCase();
  return /\b3d\b/.test(t);
}

function sessionWallClock(iso) {
  const m = String(iso || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!m) return null;
  return { date: m[1], time: m[2] };
}

function yorckSessions(film) {
  const fields = film?.fields || film || {};
  return fields.sessions || [];
}

/** Parse yorck.de /filme HTML (__NEXT_DATA__) or a films[] array. */
export function parseYorckFilms(input) {
  let films = input;
  if (typeof input === 'string') {
    const m = input.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return [];
    try {
      films = JSON.parse(m[1])?.props?.pageProps?.films || [];
    } catch {
      return [];
    }
  }
  if (!Array.isArray(films)) return [];

  const extras = [];
  for (const film of films) {
    const title = film?.fields?.title || film?.title;
    if (!title) continue;
    for (const session of yorckSessions(film)) {
      const sf = session?.fields || session || {};
      const cinemaName = sf.cinema?.fields?.name || sf.cinema?.name || '';
      const house = cinemaForYorckName(cinemaName);
      const clock = sessionWallClock(sf.startTime);
      if (!house || !clock) continue;
      extras.push({
        title,
        cinemaId: house.id,
        cinemaName: house.name,
        district: house.district,
        date: clock.date,
        time: clock.time,
        version: versionFromTokens(sf.formats),
        format: is3DTokens(sf.formats) ? '3D' : '2D',
      });
    }
  }
  return extras;
}

/** Parse one kinoprogramm.com cinema page. */
export function parseKinoprogrammCinema(html, cinemaId, meta = {}) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const extras = [];
  $('[data-kino-film]').each((_, card) => {
    const $card = $(card);
    const title = clean($card.attr('data-kino-film-title') || '');
    if (!title) return;
    $card.find('[data-kino-film-day]').each((__, dayEl) => {
      const $day = $(dayEl);
      const date = $day.attr('data-kino-film-day');
      if (!date) return;
      $day.find('[data-kino-version-row]').each((___, rowEl) => {
        const $row = $(rowEl);
        const tokens = `${$row.attr('data-kino-version-row') || ''} ${clean($row.text())}`;
        const clocks = clean($row.text()).match(/\d{1,2}:\d{2}/g) || [];
        for (const raw of clocks) {
          extras.push({
            title,
            cinemaId: String(cinemaId),
            cinemaName: meta.name || null,
            district: meta.district || null,
            date,
            time: raw.padStart(5, '0'),
            version: versionFromTokens(tokens),
            format: is3DTokens(tokens) ? '3D' : '2D',
          });
        }
      });
    });
  });
  return extras;
}

export function matchFilmByTitle(title, films) {
  const key = normTitle(title);
  if (!key) return null;
  const hits = films.filter((f) => normTitle(f.title) === key);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    return [...hits].sort((a, b) => (b.showtimes?.length || 0) - (a.showtimes?.length || 0))[0];
  }
  return null;
}

/**
 * Attach fallback showtimes to existing berlin.de films (title match).
 * Does not invent films that berlin.de never listed.
 */
export function mergeTitleShowtimes(films, extras) {
  const keys = new Map(films.map((f) => [String(f.id), new Set((f.showtimes || []).map(showtimeKey))]));
  let added = 0;
  const touched = new Set();
  const houses = new Set();
  for (const st of extras) {
    const film = matchFilmByTitle(st.title, films);
    if (!film || !st.cinemaId || !st.date || !st.time) continue;
    const row = {
      cinemaId: String(st.cinemaId),
      date: st.date,
      time: st.time,
      version: st.version || 'DE',
      format: st.format || '2D',
    };
    const seen = keys.get(String(film.id));
    const k = showtimeKey(row);
    if (seen.has(k)) continue;
    seen.add(k);
    film.showtimes.push(row);
    if (film.cinemaRefs && !film.cinemaRefs[row.cinemaId] && st.cinemaName) {
      film.cinemaRefs[row.cinemaId] = { name: st.cinemaName, district: st.district || null };
    }
    added++;
    touched.add(String(film.id));
    houses.add(row.cinemaId);
  }
  return { added, filmsTouched: touched.size, cinemasTouched: houses.size };
}

export function seedFallbackCinemas(cinemaMap) {
  for (const c of FALLBACK_CINEMAS) {
    if (cinemaMap.has(c.id)) continue;
    cinemaMap.set(c.id, { id: c.id, name: c.name, district: c.district });
  }
}

export async function fetchFallbackShowtimes() {
  const extras = [];
  const yorckHtml = await fetchText(YORCK_FILME);
  if (yorckHtml) extras.push(...parseYorckFilms(yorckHtml));
  else console.warn('  fallback: yorck.de/filme failed');

  for (const c of FALLBACK_CINEMAS.filter((x) => x.kinoprogramm)) {
    const html = await fetchText(KP_CINEMA(c.kinoprogramm));
    if (!html) {
      console.warn(`  fallback: kinoprogramm ${c.kinoprogramm} failed`);
      continue;
    }
    extras.push(...parseKinoprogrammCinema(html, c.id, c));
  }
  return extras;
}
