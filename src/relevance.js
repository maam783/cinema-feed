// Relevance scoring + country normalization + fact generation.
// Everything is derived at scrape time from structured data — no per-run LLM cost.

// German country name (as berlin.de writes it) -> canonical info.
// weight/rank express "relevance for Western film culture" (concept: default USA).
const COUNTRIES = [
  ['usa', { code: 'US', name: 'USA', flag: '🇺🇸', weight: 15 }],
  ['vereinigte staaten', { code: 'US', name: 'USA', flag: '🇺🇸', weight: 15 }],
  ['großbritannien', { code: 'GB', name: 'Großbritannien', flag: '🇬🇧', weight: 12 }],
  ['grossbritannien', { code: 'GB', name: 'Großbritannien', flag: '🇬🇧', weight: 12 }],
  ['vereinigtes königreich', { code: 'GB', name: 'Großbritannien', flag: '🇬🇧', weight: 12 }],
  ['england', { code: 'GB', name: 'Großbritannien', flag: '🇬🇧', weight: 12 }],
  ['deutschland', { code: 'DE', name: 'Deutschland', flag: '🇩🇪', weight: 11 }],
  ['frankreich', { code: 'FR', name: 'Frankreich', flag: '🇫🇷', weight: 9 }],
  ['kanada', { code: 'CA', name: 'Kanada', flag: '🇨🇦', weight: 7 }],
  ['australien', { code: 'AU', name: 'Australien', flag: '🇦🇺', weight: 6 }],
  ['italien', { code: 'IT', name: 'Italien', flag: '🇮🇹', weight: 6 }],
  ['spanien', { code: 'ES', name: 'Spanien', flag: '🇪🇸', weight: 6 }],
  ['irland', { code: 'IE', name: 'Irland', flag: '🇮🇪', weight: 5 }],
  ['neuseeland', { code: 'NZ', name: 'Neuseeland', flag: '🇳🇿', weight: 5 }],
  ['japan', { code: 'JP', name: 'Japan', flag: '🇯🇵', weight: 5 }],
  ['südkorea', { code: 'KR', name: 'Südkorea', flag: '🇰🇷', weight: 5 }],
  ['niederlande', { code: 'NL', name: 'Niederlande', flag: '🇳🇱', weight: 4 }],
  ['belgien', { code: 'BE', name: 'Belgien', flag: '🇧🇪', weight: 4 }],
  ['österreich', { code: 'AT', name: 'Österreich', flag: '🇦🇹', weight: 4 }],
  ['schweiz', { code: 'CH', name: 'Schweiz', flag: '🇨🇭', weight: 4 }],
  ['schweden', { code: 'SE', name: 'Schweden', flag: '🇸🇪', weight: 4 }],
  ['dänemark', { code: 'DK', name: 'Dänemark', flag: '🇩🇰', weight: 4 }],
  ['norwegen', { code: 'NO', name: 'Norwegen', flag: '🇳🇴', weight: 4 }],
];

export function normalizeCountry(raw) {
  if (!raw) return { code: 'XX', name: 'Andere', flag: '🌍', weight: 3 };
  // berlin.de may list several ("USA / Deutschland"); take the first recognized one.
  const parts = raw.split(/[\/,]/).map((s) => s.trim().toLowerCase());
  for (const p of parts) {
    for (const [needle, info] of COUNTRIES) if (p.includes(needle)) return info;
  }
  const first = (parts[0] || raw).trim();
  return { code: 'XX', name: first ? first[0].toUpperCase() + first.slice(1) : 'Andere', flag: '🌍', weight: 3 };
}

/** Canonical ordering of countries for the filter UI (by Western-culture relevance). */
export function countryFilterOrder() {
  const seen = new Set();
  const out = [];
  for (const [, info] of COUNTRIES) {
    if (seen.has(info.code)) continue;
    seen.add(info.code);
    out.push(info);
  }
  return out.sort((a, b) => b.weight - a.weight);
}

const daysBetween = (isoA, isoB) => Math.round((Date.parse(isoA) - Date.parse(isoB)) / 86400000);

/**
 * Relevance 0..100. Footprint (how widely it screens) dominates — the best free
 * popularity proxy — then country, franchise, budget, popularity, recency.
 */
export function computeRelevance(film, { now }) {
  const cinemas = film.cinemaIds?.length || 0;
  const shows = film.showtimeCount || film.showtimes?.length || 0;
  const raw = cinemas * 2 + shows * 0.3;
  const footprint = Math.min(60, (60 * Math.log10(1 + raw)) / Math.log10(1 + 200));

  const country = Math.min(15, (film.countryInfo?.weight ?? 3));

  const franchise = film.collection ? 8 : 0;

  const b = film.budget || 0;
  const budget = b >= 150e6 ? 10 : b >= 80e6 ? 7 : b >= 40e6 ? 4 : b >= 15e6 ? 2 : 0;

  let popularity = 0;
  if (typeof film.popularity === 'number') popularity = Math.min(12, film.popularity / 10);

  let recency = 0;
  if (film.releaseDate) {
    const d = daysBetween(film.releaseDate, now);
    if (d >= -3 && d <= 21) recency = 10; // just released / about to
    else if (d > 21 && d <= 60) recency = 7; // upcoming premiere
    else if (d >= -14 && d < -3) recency = 6; // very recent
    else if (d > 60) recency = 4;
  }
  if (film.isUpcoming) recency = Math.max(recency, 8);

  const rating = film.ratings?.audience ? Math.min(5, (film.ratings.audience / 10) * 5) : 0;

  const score = Math.round(
    Math.min(100, footprint + country + franchise + budget + popularity + recency + rating)
  );
  return { score, breakdown: { footprint, country, franchise, budget, popularity, recency, rating } };
}

const mio = (n) => {
  const m = n / 1e6;
  return m >= 100 ? `${Math.round(m)}` : m >= 10 ? `${Math.round(m)}` : m.toFixed(1).replace('.', ',');
};

/** Template facts from structured data (no LLM). Up to `max` short German lines. */
export function generateFacts(film, max = 4) {
  const facts = [];
  if (film.collection) facts.push(`Teil der Filmreihe „${film.collection}".`);
  if (film.budget) facts.push(`Produktionsbudget: rund ${mio(film.budget)} Mio. $.`);
  if (film.boxOffice && film.boxOffice > (film.budget || 0))
    facts.push(`Weltweites Einspielergebnis: ${mio(film.boxOffice)} Mio. $.`);
  if (film.basedOn) facts.push(`Basiert auf: ${film.basedOn}.`);
  if (film.director && film.cast?.length)
    facts.push(`Regie: ${film.director}, mit ${film.cast.slice(0, 2).join(' und ')}.`);
  else if (film.cast?.length) facts.push(`In den Hauptrollen: ${film.cast.slice(0, 3).join(', ')}.`);
  if (film.runtime && film.runtime >= 150)
    facts.push(`Mit ${film.runtime} Minuten ein besonders langer Film.`);
  if (film.ratings?.imdb) facts.push(`IMDb-Wertung: ${film.ratings.imdb}/10.`);
  // de-dupe & trim
  return [...new Set(facts)].slice(0, max);
}
