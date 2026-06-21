// Enrichment: key-less Wikidata (budget/box office/series/IMDb) + optional TMDB/OMDb.
// Cached per film id (these facts rarely change) so warm runs only hit new films.
import { fetchJson, fetchText } from './util.js';

const WD_UA = 'CinemaBerlinApp/1.0 (private; contact via github.com/maam783)';
const CACHE_MAX_AGE_DAYS = 30;

const sparqlEscape = (s) => s.replace(/["\\]/g, '\\$&');

/** Query Wikidata for one film by German/English label (+ optional year). Best-effort. */
async function wikidata(title, year) {
  const labelFilter = `{ ?film rdfs:label "${sparqlEscape(title)}"@de } UNION { ?film rdfs:label "${sparqlEscape(title)}"@en }`;
  const yearClause = year
    ? `OPTIONAL { ?film wdt:P577 ?pub } FILTER(!BOUND(?pub) || YEAR(?pub) = ${year} || YEAR(?pub) = ${year - 1} || YEAR(?pub) = ${year + 1})`
    : '';
  const q = `SELECT ?film ?budget ?box ?seriesLabel ?basedOnLabel ?imdb WHERE {
    ${labelFilter}
    ?film wdt:P31/wdt:P279* wd:Q11424 .
    OPTIONAL { ?film wdt:P2130 ?budget }
    OPTIONAL { ?film wdt:P2142 ?box }
    OPTIONAL { ?film wdt:P179 ?series }
    OPTIONAL { ?film wdt:P144 ?basedOn }
    OPTIONAL { ?film wdt:P345 ?imdb }
    ${yearClause}
    SERVICE wikibase:label { bd:serviceParam wikibase:language "de,en". }
  } LIMIT 1`;
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`;
  let json = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, {
      headers: { 'User-Agent': WD_UA, Accept: 'application/sparql-results+json' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return {};
    json = await res.json();
  } catch {
    return {};
  }
  const b = json?.results?.bindings?.[0];
  if (!b) return {};
  const num = (v) => (v?.value != null && !isNaN(+v.value) ? +v.value : null);
  return {
    budget: num(b.budget),
    boxOffice: num(b.box),
    collection: b.seriesLabel?.value || null,
    basedOn: b.basedOnLabel?.value || null,
    imdbId: b.imdb?.value || null,
    source: 'wikidata',
  };
}

/** Optional TMDB lookup (richer ratings/popularity/budget/collection/poster). */
async function tmdb(title, year, key) {
  if (!key) return {};
  const s = await fetchJson(
    `https://api.themoviedb.org/3/search/movie?api_key=${key}&language=de-DE&query=${encodeURIComponent(
      title
    )}${year ? `&year=${year}` : ''}`
  );
  const hit = s?.results?.[0];
  if (!hit) return {};
  const d = await fetchJson(
    `https://api.themoviedb.org/3/movie/${hit.id}?api_key=${key}&language=de-DE`
  );
  if (!d) return {};
  return {
    budget: d.budget || null,
    boxOffice: d.revenue || null,
    collection: d.belongs_to_collection?.name || null,
    popularity: typeof d.popularity === 'number' ? d.popularity : null,
    voteCount: typeof d.vote_count === 'number' ? d.vote_count : null,
    imdbId: d.imdb_id || null,
    poster: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : null,
    ratings: d.vote_average ? { audience: Math.round(d.vote_average * 10) / 10, source: 'TMDB' } : null,
    source: 'tmdb',
  };
}

/** Optional OMDb lookup (IMDb / Rotten Tomatoes / Metacritic). */
async function omdb(title, year, imdbId, key) {
  if (!key) return {};
  const base = `https://www.omdbapi.com/?apikey=${key}`;
  const url = imdbId
    ? `${base}&i=${imdbId}`
    : `${base}&t=${encodeURIComponent(title)}${year ? `&y=${year}` : ''}`;
  const d = await fetchJson(url);
  if (!d || d.Response === 'False') return {};
  const ratings = {};
  for (const r of d.Ratings || []) {
    if (r.Source === 'Internet Movie Database') ratings.imdb = parseFloat(r.Value);
    if (r.Source === 'Rotten Tomatoes') ratings.rt = parseInt(r.Value);
    if (r.Source === 'Metacritic') ratings.critics = parseInt(r.Value);
  }
  return { ratings, imdbId: d.imdbID || imdbId || null };
}

const isFresh = (entry) =>
  entry && entry.ts && Date.now() - entry.ts < CACHE_MAX_AGE_DAYS * 86400000;

/** Enrich a single film, using/refreshing the cache. Returns merged enrichment object. */
export async function enrichFilm(film, { cache, tmdbKey, omdbKey }) {
  const cached = cache[film.id];
  if (isFresh(cached)) return cached.data;

  let data = {};
  // Prefer TMDB when available (richest), else Wikidata.
  const t = await tmdb(film.title, film.year, tmdbKey).catch(() => ({}));
  const w = Object.keys(t).length ? {} : await wikidata(film.title, film.year).catch(() => ({}));
  data = { ...w, ...t };
  // Ratings from OMDb (best critics/audience), merged on top.
  const o = await omdb(film.title, film.year, data.imdbId, omdbKey).catch(() => ({}));
  if (o.ratings && Object.keys(o.ratings).length) {
    data.ratings = { ...(data.ratings || {}), ...o.ratings, source: o.ratings.rt ? 'RT/IMDb' : 'IMDb' };
    data.imdbId = data.imdbId || o.imdbId;
  }

  cache[film.id] = { ts: Date.now(), data };
  return data;
}
