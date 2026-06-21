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

    $li.find('table tbody tr').each((__, tr) => {
      const tds = $(tr).find('td');
      const date = parseGermanDate(clean($(tds[0]).text()));
      const timesTxt = clean($(tds[1]).text());
      if (!date || !timesTxt) return;
      for (const part of timesTxt.split(',')) {
        const tm = part.match(/(\d{1,2}:\d{2})/);
        if (!tm) continue;
        const suffix = part.replace(tm[1], '');
        showtimes.push({
          cinemaId,
          date,
          time: tm[1].padStart(5, '0'),
          version: suffix.trim() ? VERSION(suffix) : baseVersion,
        });
      }
    });
  });

  return {
    id,
    title,
    synopsis: synopsis || null,
    poster: `${BASE}/_img/filmbilder/p_${id}_Print2.jpg`,
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

/** Parse a cinema detail page → {id, name, district, address, website}. */
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
  return { id, name, district, address, website };
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
