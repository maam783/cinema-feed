// Parse berlin.de/kino: film catalog, film details + showtimes, cinemas.
import * as cheerio from 'cheerio';
import { fetchText, mapLimit, parseGermanDate, clean } from './util.js';

const BASE = 'https://www.berlin.de/kino';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const filmIdsFrom = (html) => {
  const ids = new Set();
  const re = /filmdetail\.php\/(\d+)/g;
  let m;
  while ((m = re.exec(html))) ids.add(m[1]);
  return ids;
};

/** Discover all film ids. Returns { playing:Set, upcoming:Set, neustart:Set }. */
export async function discoverFilmIds() {
  const letterHtmls = await mapLimit(LETTERS, 4, (L) =>
    fetchText(`${BASE}/_bin/azfilm.php/${L}`)
  );
  const playing = new Set();
  for (const h of letterHtmls) if (h) for (const id of filmIdsFrom(h)) playing.add(id);

  const [vorschauHtml, neustartHtml] = await Promise.all([
    fetchText(`${BASE}/vorschau/`),
    fetchText(`${BASE}/neustarts/`),
  ]);
  const vorschau = vorschauHtml ? filmIdsFrom(vorschauHtml) : new Set();
  const neustart = neustartHtml ? filmIdsFrom(neustartHtml) : new Set();
  // Upcoming = announced in vorschau but not yet in the playing catalog.
  const upcoming = new Set([...vorschau].filter((id) => !playing.has(id)));
  return { playing, upcoming, neustart };
}

const VERSION = (txt) => {
  const t = (txt || '').toLowerCase();
  if (/\bome?u\b|o\.m\.u|untertitel/.test(t)) return 'OmU';
  if (/\bo[vf]\b|originalfassung|original version|engl|\(en\)|\(eng\)/.test(t)) return 'OV';
  return 'DE';
};

const FSK = (s) => {
  const m = (s || '').match(/\d+/);
  return m ? +m[0] : null;
};
const RUNTIME = (s) => {
  const m = (s || '').match(/(\d+)\s*min/i);
  return m ? +m[1] : null;
};

/** Parse a film detail page. Returns film object (without enrichment/relevance) or null. */
export function parseFilm(html, id) {
  if (!html) return null;
  const $ = cheerio.load(html);

  // Title: prefer the page <title> trimmed at the boilerplate suffix.
  let title = clean($('title').first().text()).split(' - Filmbeschreibung')[0];
  if (!title) title = clean($('h1').first().text());
  if (!title) return null;

  // Body text for labeled "Filmdaten" parsing (robust to markup tweaks).
  const bodyText = clean($('main').text() || $('body').text());

  const field = (label) => {
    // capture up to the next known label or end
    const re = new RegExp(
      `${label}:\\s*(.+?)\\s*(?:Filmstart|Genre|Darsteller|Regie|L[aä]nge|FSK|Land|Jahr|Filmwebsite|In diesen Kinos|$)`,
      'i'
    );
    const m = bodyText.match(re);
    return m ? clean(m[1]) : '';
  };

  const releaseDate = parseGermanDate(field('Filmstart'));
  const genre = field('Genre') || null;
  const castRaw = field('Darsteller');
  const cast = castRaw ? castRaw.split(/,\s*/).map(clean).filter(Boolean).slice(0, 12) : [];
  const director = field('Regie') || null;
  const runtime = RUNTIME(field('Länge') || field('Lange'));
  const fsk = FSK(field('FSK'));
  const country = field('Land') || null;
  const yearM = field('Jahr').match(/\d{4}/);
  const year = yearM ? +yearM[0] : null;

  // Synopsis: first substantial paragraph in the article body.
  let synopsis = '';
  $('p').each((_, el) => {
    if (synopsis) return;
    const t = clean($(el).text());
    if (t.length > 80 && !/^"/.test(t) && !/Filmstart|Cookie|Barrierefrei/i.test(t)) synopsis = t;
  });

  // Poster: read the actual image the detail page links, don't guess the URL. berlin.de uses
  // two naming schemes — p_{id}_PrintN.jpg (proper portrait posters) for most films, but
  // pic_{id}_{n}.jpg (also portrait) for others. The old hardcoded p_{id}_Print2.jpg 404'd for
  // ~15% of films (those without a Print2 poster) → blank placeholder in the app. Prefer Print2
  // (the standard poster), then any Print poster, then the first pic image; only if the page
  // references no film image at all do we fall back to the constructed guess.
  const posterFile =
    (html.includes(`p_${id}_Print2.jpg`) && `p_${id}_Print2.jpg`) ||
    (html.match(new RegExp(`p_${id}_Print\\d+\\.jpg`, 'i')) || [])[0] ||
    (html.match(new RegExp(`pic_${id}_\\d+\\.jpg`, 'i')) || [])[0] ||
    `p_${id}_Print2.jpg`;
  const poster = `${BASE}/_img/filmbilder/${posterFile}`;

  // Website (external film site): the link in the "Filmwebsite" row of Filmdaten.
  let website = null;
  const wm = html.match(/Filmwebsite[\s\S]{0,200}?href="(https?:\/\/[^"]+)"/i);
  if (wm && !/berlin\.de|facebook|instagram|bsky|twitter|youtube/i.test(wm[1])) website = wm[1];

  // Showtimes: each <li> in the accordion = one cinema.
  const showtimes = [];
  const cinemaRefs = new Map(); // cinemaId -> {name, district}
  $('ul.js-accordion > li').each((_, li) => {
    const $li = $(li);
    const trigger = $li.find('.js-accordion__trigger').first();
    // cinema name = trigger text minus the nested "(District)" span
    const name = clean(trigger.clone().find('.info').remove().end().text());
    const district = clean(trigger.find('.info').text()).replace(/[()]/g, '') || null;
    if (!name) return;

    // cinema id from the kinodetail link in the panel
    let cinemaId = null;
    const cm = ($li.find('a[href*="kinodetail.php"]').first().attr('href') || '').match(
      /kinodetail\.php\/(\d+)/
    );
    if (cm) cinemaId = cm[1];
    if (!cinemaId) cinemaId = `name:${name}`; // fallback key

    // base version from the film link text inside the panel ("Title (OmU)")
    const baseVersion = VERSION(clean($li.find('a[href*="filmdetail.php"]').first().text()));
    cinemaRefs.set(cinemaId, { name, district });
    pushTableShowtimes($, $li, showtimes, { cinemaId, baseVersion });
  });

  return {
    id,
    title,
    synopsis: synopsis || null,
    poster,
    releaseDate,
    genre,
    cast,
    director,
    runtime,
    fsk,
    country,
    year,
    website,
    showtimes,
    cinemaRefs: Object.fromEntries(cinemaRefs),
  };
}

/** berlin.de table rows → showtimes. Shared by film pages (one cinema) and cinema pages (one film). */
function pushTableShowtimes($, $ctx, showtimes, { cinemaId, baseVersion, filmId }) {
  $ctx.find('table tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    const date = parseGermanDate(clean($(tds[0]).text()));
    const timesTxt = clean($(tds[1]).text());
    if (!date || !timesTxt) return;
    for (const part of timesTxt.split(',')) {
      const tm = part.match(/(\d{1,2}:\d{2})/);
      if (!tm) continue;
      const suffix = part.replace(tm[1], '');
      const row = {
        cinemaId,
        date,
        time: tm[1].padStart(5, '0'),
        version: suffix.trim() ? VERSION(suffix) : baseVersion,
      };
      if (filmId) row.filmId = filmId;
      showtimes.push(row);
    }
  });
}

export function showtimeKey(s) {
  return `${s.cinemaId}\t${s.date}\t${s.time}\t${s.version}\t${s.format || '2D'}`;
}

/** Trailing " 3D" / "(3D)" only — never "Toy Story 3". */
const TITLE_3D = /\s*\(?3D\)?\s*$/i;
export function strip3DTitle(title) {
  return String(title || '').replace(TITLE_3D, '').trim();
}
export function is3DTitle(title) {
  return TITLE_3D.test(String(title || ''));
}

function formatRow(st, format) {
  return {
    cinemaId: String(st.cinemaId),
    date: st.date,
    time: st.time,
    version: st.version || 'DE',
    format,
  };
}

/**
 * Collapse "Title 3D" into "Title" when both exist. berlin.de lists them as
 * separate films; they are the same movie in different auditoriums.
 * 3D-only titles (Antarctica 3D) stay put. Alias ids keep favorites working.
 */
export function merge3DVariants(films) {
  const keyOf = (f) => `${strip3DTitle(f.title).toLowerCase()}\t${f.year || ''}`;
  const groups = new Map();
  for (const f of films) {
    const k = keyOf(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const out = [];
  let collapsed = 0;
  for (const group of groups.values()) {
    const bases = group.filter((f) => !is3DTitle(f.title));
    const extras = group.filter((f) => is3DTitle(f.title));
    if (!bases.length || !extras.length) {
      const fmt = bases.length ? '2D' : '3D';
      for (const f of group) {
        for (const st of f.showtimes || []) if (!st.format) st.format = fmt;
      }
      out.push(...group);
      continue;
    }
    const base = [...bases].sort((a, b) => (b.showtimes?.length || 0) - (a.showtimes?.length || 0))[0];
    const seen = new Set();
    const showtimes = [];
    const absorb = (src, format) => {
      for (const st of src.showtimes || []) {
        const row = formatRow(st, st.format || format);
        const k = showtimeKey(row);
        if (seen.has(k)) continue;
        seen.add(k);
        showtimes.push(row);
      }
      if (base.cinemaRefs && src.cinemaRefs) Object.assign(base.cinemaRefs, src.cinemaRefs);
    };
    absorb(base, '2D');
    const aliasIds = [...(base.aliasIds || [])];
    for (const extra of extras) {
      absorb(extra, '3D');
      aliasIds.push(String(extra.id));
    }
    for (const other of bases) {
      if (other === base) continue;
      absorb(other, '2D');
      aliasIds.push(String(other.id));
    }
    base.showtimes = showtimes;
    base.aliasIds = [...new Set(aliasIds)];
    out.push(base);
    collapsed += extras.length + bases.length - 1;
  }
  return { films: out, collapsed };
}

/**
 * Attach showtimes found on cinema pages to the matching film objects.
 * berlin.de's filmdetail accordion sometimes omits a house that kinodetail lists
 * for the same film id (Zoo Palast 2D Spider-Man, Die Odyssee, Aug 2026).
 * Dedupes by cinema+day+time+version. Unknown film ids are skipped.
 */
export function mergeCinemaShowtimes(films, extras) {
  const byId = new Map(films.map((f) => [String(f.id), f]));
  const keys = new Map(films.map((f) => [String(f.id), new Set((f.showtimes || []).map(showtimeKey))]));
  let added = 0;
  const touched = new Set();
  for (const st of extras) {
    const film = byId.get(String(st.filmId));
    if (!film || !st.cinemaId || !st.date || !st.time) continue;
    const row = {
      cinemaId: String(st.cinemaId),
      date: st.date,
      time: st.time,
      version: st.version || 'DE',
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
  }
  return { added, filmsTouched: touched.size };
}

/** Parse a cinema detail page → {id, name, district, address, website, showtimes}. */
export function parseCinema(html, id) {
  if (!html) return null;
  const $ = cheerio.load(html);
  let name = clean($('h1').first().text()) || clean($('title').first().text()).split(' - ')[0];
  const body = clean($('main').text() || $('body').text());
  const addrM = body.match(/Adresse:\s*(.+?)\s*(?:Stadtplan|Telefon|Preise|$)/i);
  const address = addrM ? clean(addrM[1]) : null;
  // district: "12487 Berlin - Treptow"
  let district = null;
  if (address) {
    const dm = address.match(/Berlin\s*-\s*([A-Za-zÄÖÜäöüß\- ]+)/);
    if (dm) district = clean(dm[1]);
  }
  let website = null;
  $('a').each((_, el) => {
    if (website) return;
    const href = $(el).attr('href') || '';
    if (
      /^https?:\/\//i.test(href) &&
      !/berlin\.de|facebook|instagram|bsky|twitter|google|vbb\.de|youtube|stadtplan/i.test(href)
    )
      website = href;
  });

  // Film accordion only — the same page also has a transit js-accordion. A panel
  // without filmdetail.php is not a screening.
  const showtimes = [];
  $('ul.js-accordion > li').each((_, li) => {
    const $li = $(li);
    const filmHref = $li.find('a[href*="filmdetail.php"]').first().attr('href') || '';
    const fm = filmHref.match(/filmdetail\.php\/(\d+)/);
    if (!fm) return;
    const baseVersion = VERSION(clean($li.find('a[href*="filmdetail.php"]').first().text()));
    pushTableShowtimes($, $li, showtimes, { cinemaId: String(id), baseVersion, filmId: fm[1] });
  });

  return { id, name, district, address, website, showtimes };
}

export async function fetchFilm(id) {
  const html = await fetchText(`${BASE}/_bin/filmdetail.php/${id}/`);
  return parseFilm(html, id);
}
export async function fetchCinema(id) {
  if (String(id).startsWith('name:')) return null;
  const html = await fetchText(`${BASE}/_bin/kinodetail.php/${id}`);
  return parseCinema(html, id);
}

export { BASE };
