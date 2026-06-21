// Orchestrator: discover -> parse -> cinemas -> enrich -> score -> assemble feed.json
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { discoverFilmIds, fetchFilm, fetchCinema } from './berlin.js';
import { enrichFilm } from './enrich.js';
import { computeRelevance, generateFacts, normalizeCountry, countryFilterOrder } from './relevance.js';
import { bookingUrl } from './cinemas.js';
import { mapLimit, sleep } from './util.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..'); // repo root = scraper dir (contains src/, site/, cache/)
const SITE = process.env.SITE_DIR || resolve(ROOT, 'site');
const CACHE = process.env.CACHE_DIR || resolve(ROOT, 'cache');
const FEED_VERSION = 1;
const MIN_FILMS = 25; // plausibility gate
const MAX_FILMS = process.env.MAX_FILMS ? +process.env.MAX_FILMS : Infinity;

const todayISO = () => new Date().toISOString().slice(0, 10);
const log = (...a) => console.log(...a);

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const now = todayISO();
  log(`Cinema scraper — ${now}`);

  // 1) Discover film ids
  const { playing, upcoming, neustart } = await discoverFilmIds();
  let ids = [...new Set([...playing, ...upcoming])];
  if (ids.length > MAX_FILMS) ids = ids.slice(0, MAX_FILMS);
  log(`Discovered ${ids.length} films (playing ${playing.size}, upcoming ${upcoming.size}).`);
  if (ids.length === 0) {
    console.error('No films discovered — aborting (keeping previous feed).');
    process.exit(1);
  }

  // 2) Fetch + parse film detail pages
  const failedIds = [];
  const rawFilms = (
    await mapLimit(ids, 4, async (id) => {
      const f = await fetchFilm(id);
      if (!f) failedIds.push(id);
      return f;
    })
  ).filter(Boolean);
  log(`Discovered ${ids.length}; parsed ${rawFilms.length} films (${failedIds.length} failed pass 1).`);

  // Second pass: most failures are transient 429s. Cool down, then retry slowly.
  if (failedIds.length) {
    await sleep(15000);
    const retry = await mapLimit(failedIds, 2, async (id) => fetchFilm(id));
    let healed = 0;
    for (const f of retry) if (f) { rawFilms.push(f); healed++; }
    log(`  pass 2 healed ${healed}/${failedIds.length}.`);
  }
  const failed = ids.length - rawFilms.length;

  if (rawFilms.length < MIN_FILMS) {
    console.error(`Only ${rawFilms.length} films parsed (< ${MIN_FILMS}) — aborting to keep previous feed.`);
    process.exit(1);
  }

  // 3) Cinema registry — name/district come free from film pages; address/website cached.
  const cinemaCache = await readJson(resolve(CACHE, 'cinemas.json'), {});
  const cinemaMap = new Map(); // id -> {id,name,district,address,website,bookingUrl}
  for (const f of rawFilms) {
    for (const [cid, ref] of Object.entries(f.cinemaRefs || {})) {
      if (!cinemaMap.has(cid)) cinemaMap.set(cid, { id: cid, ...ref });
    }
  }
  // enrich cinemas with address/website (cached; only fetch unknowns)
  const cinemasToFetch = [...cinemaMap.keys()].filter(
    (cid) => !cid.startsWith('name:') && !cinemaCache[cid]
  );
  log(`Cinemas: ${cinemaMap.size} (${cinemasToFetch.length} new to fetch).`);
  await mapLimit(cinemasToFetch, 4, async (cid) => {
    const c = await fetchCinema(cid);
    if (c) cinemaCache[cid] = { address: c.address, website: c.website };
  });
  for (const [cid, c] of cinemaMap) {
    const extra = cinemaCache[cid] || {};
    c.address = extra.address || null;
    c.website = extra.website || null;
  }

  // 4) Enrich (cached) + 5) score + facts
  const enrichCache = await readJson(resolve(CACHE, 'enrich.json'), {});
  const tmdbKey = process.env.TMDB_API_KEY || '';
  const omdbKey = process.env.OMDB_API_KEY || '';

  const skipEnrich = process.env.SKIP_ENRICH === '1';
  const films = [];
  await mapLimit(rawFilms, tmdbKey || omdbKey ? 3 : 2, async (f) => {
    const enr = skipEnrich ? {} : await enrichFilm(f, { cache: enrichCache, tmdbKey, omdbKey }).catch(() => ({}));
    const ci = normalizeCountry(f.country);
    const cinemaIds = [...new Set(f.showtimes.map((s) => s.cinemaId))];
    const film = {
      ...f,
      countryInfo: ci,
      countryCode: ci.code,
      countryFlag: ci.flag,
      country: ci.name,
      collection: enr.collection || null,
      budget: enr.budget || null,
      boxOffice: enr.boxOffice || null,
      basedOn: enr.basedOn || null,
      imdbId: enr.imdbId || null,
      popularity: enr.popularity ?? null,
      ratings: enr.ratings || null,
      poster: enr.poster || f.poster, // prefer TMDB poster if present
      cinemaIds,
      cinemaCount: cinemaIds.length,
      showtimeCount: f.showtimes.length,
      isUpcoming: upcoming.has(f.id) || (f.showtimes.length === 0 && !!f.releaseDate),
      isNew: neustart.has(f.id),
    };
    const { score } = computeRelevance(film, { now });
    film.relevance = score;
    film.facts = generateFacts(film);
    // premiere = recent or upcoming theatrical start
    film.isPremiere =
      film.isUpcoming ||
      (film.releaseDate &&
        (Date.parse(film.releaseDate) - Date.parse(now)) / 86400000 >= -21);
    delete film.cinemaRefs;
    delete film.countryInfo;
    films.push(film);
  });

  // de-dupe by id (already unique) — keep
  films.sort((a, b) => b.relevance - a.relevance);

  // 6) Cinemas list with booking URLs (direct chain or null -> app builds film-specific search)
  const cinemas = [...cinemaMap.values()].map((c) => {
    const direct = bookingUrl(c.name, '', '');
    return {
      ...c,
      bookingUrl: direct.includes('google.com/search') ? null : direct,
    };
  });

  const totalShowtimes = films.reduce((n, f) => n + f.showtimeCount, 0);
  const feed = {
    meta: {
      version: FEED_VERSION,
      generatedAt: new Date().toISOString(),
      today: now,
      source: 'berlin.de/kino',
      filmCount: films.length,
      cinemaCount: cinemas.length,
      showtimeCount: totalShowtimes,
      partial: failed > 0,
      enriched: !!(tmdbKey || omdbKey) ? 'tmdb/omdb+wikidata' : 'wikidata',
    },
    countries: countryFilterOrder(),
    cinemas,
    films,
  };

  // 7) Write outputs
  await mkdir(SITE, { recursive: true });
  await mkdir(CACHE, { recursive: true });
  await writeFile(resolve(SITE, 'feed.json'), JSON.stringify(feed));
  await writeFile(resolve(SITE, 'meta.json'), JSON.stringify(feed.meta, null, 2));
  await writeFile(resolve(CACHE, 'enrich.json'), JSON.stringify(enrichCache));
  await writeFile(resolve(CACHE, 'cinemas.json'), JSON.stringify(cinemaCache));

  log(
    `Feed written: ${films.length} films, ${cinemas.length} cinemas, ${totalShowtimes} showtimes` +
      `${feed.meta.partial ? ' (partial)' : ''}.`
  );
  log(`Top 5 by relevance: ${films.slice(0, 5).map((f) => `${f.title}(${f.relevance})`).join(', ')}`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
