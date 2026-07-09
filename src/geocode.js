// Free, key-less geocoding via OpenStreetMap Nominatim. Results are cached permanently by the
// caller (cache/cinemas.json) — a cinema's street address doesn't move, so this only ever runs
// once per cinema. Usage policy: max 1 request/sec (enforced below — never call concurrently)
// and a descriptive User-Agent identifying the application, not a browser UA.
const NOMINATIM_UA =
  'CinemaBerlinApp/1.0 (private single-user iOS app; contact: vvzyhpfpzz@privaterelay.appleid.com)';
const MIN_GAP_MS = 1100; // stay safely under Nominatim's 1 req/s limit
let _last = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strip berlin.de's appended " - <Bezirk>" suffix — not part of the mailing address and
 * confuses the geocoder (e.g. "Bölschestr. 69 12587 Berlin - Köpenick" → "... 12587 Berlin").
 * Cuts from the FIRST " - " (space-hyphen-space), not the last: some Bezirk names are
 * themselves hyphenated without spaces (e.g. "- Neukölln-Tempelhof"), which a "last segment"
 * match would fail to strip — confirmed against the live feed, this fixed a real geocode miss. */
function cleanAddress(address) {
  return address.replace(/\s-\s.*$/, '').trim();
}

/** address string -> {lat, lon} or null (not found, or the request failed — caller retries
 * on a later run since failures are never cached). */
export async function geocodeAddress(address) {
  if (!address) return null;
  const wait = Math.max(0, MIN_GAP_MS - (Date.now() - _last));
  if (wait) await sleep(wait);
  _last = Date.now();

  const q = encodeURIComponent(`${cleanAddress(address)}, Germany`);
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=de&q=${q}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    const lat = +data[0].lat, lon = +data[0].lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  } catch {
    return null;
  }
}
