// Booking-link resolution for Berlin cinemas.
// berlin.de offers no per-showtime deep links, so we map the high-traffic premiere
// cinemas to their official ticketing sites, and fall back to a Google showtimes
// search (which surfaces a "Tickets" widget) for the long tail.

// substring of the berlin.de cinema name (lowercased) -> official ticketing/site URL
// Every URL below is HTTP-verified (curl -L → 200; cineplex.de sits behind a WAF that 403s
// curl, its slugs are verified via site: search instead). The first batch of chain URLs was
// guessed from memory and silently 404'd (CineStar, CinemaxX, UCI, Zoo Palast) — always
// verify before adding here.
const BOOKING = [
  ['zoo palast', 'https://zoopalast.premiumkino.de/'],
  ['zoopalast', 'https://zoopalast.premiumkino.de/'],
  ['cubix', 'https://www.cinestar.de/kino-berlin-cubix-am-alexanderplatz'],
  ['kulturbrauerei', 'https://www.cinestar.de/berlin-kino-in-der-kulturbrauerei'],
  ['hellersdorf', 'https://www.cinestar.de/kino-berlin-hellersdorf'],
  ['cinestar tegel', 'https://www.cinestar.de/kino-berlin-tegel'],
  ['cinestar', 'https://www.cinestar.de/'],
  ['cinemaxx', 'https://www.cinemaxx.de/kinoprogramm/berlin'],
  ['uci', 'https://www.uci-kinowelt.de/'],
  // Cineplex: location-slug scheme confirmed via cineplex.de search results (their WAF
  // blocks curl, so verified via site: search, not HTTP). Specific houses before the
  // generic fallback — first match wins.
  ['titania', 'https://www.cineplex.de/berlin-steglitz'],
  ['alhambra', 'https://www.cineplex.de/berlin-alhambra'],
  ['neukölln arcaden', 'https://www.cineplex.de/berlin-neukoelln'],
  ['cineplex spandau', 'https://www.cineplex.de/berlin-spandau'],
  ['cineplex', 'https://www.cineplex.de/'],
  ['astra', 'https://www.astra-berlin.de/'],
  ['thalia', 'https://www.thalia-potsdam.de/'],
  ['spreehöfe', 'https://www.kino-spreehoefe.de/'],
  ['astor', 'https://www.astor-filmlounge.de/berlin/'],
  ['delphi filmpalast', 'https://www.yorck.de/kinos/delphi-filmpalast'],
  ['delphi lux', 'https://www.yorck.de/kinos/delphi-lux'],
  ['international', 'https://www.yorck.de/kinos/kino-international'],
  ['kant', 'https://www.yorck.de/kinos/kant-kino'],
  ['cinema paris', 'https://www.yorck.de/kinos/cinema-paris'],
  ['capitol dahlem', 'https://www.yorck.de/kinos/capitol-dahlem'],
  ['filmtheater am friedrichshain', 'https://www.yorck.de/kinos/filmtheater-am-friedrichshain'],
  ['neues off', 'https://www.yorck.de/kinos/neues-off'],
  ['odeon', 'https://www.yorck.de/kinos/odeon'],
  ['passage', 'https://www.yorck.de/kinos/passage'],
  ['rollberg', 'https://www.yorck.de/kinos/rollberg'],
  ['blauer stern', 'https://www.yorck.de/kinos/blauer-stern'],
  ['yorck', 'https://www.yorck.de/'],
  ['babylon', 'https://www.babylonberlin.eu/'],
  ['b-ware', 'https://www.ladenkino.de/'],
  ['ladenkino', 'https://www.ladenkino.de/'],
  ['lichtblick', 'https://www.lichtblick-kino.org/'],
  ['eva lichtspiele', 'https://www.eva-lichtspiele.de/'],
  ['bundesplatz', 'https://www.bundesplatz-kino.de/'],
  ['il kino', 'https://www.ilkino.de/'],
  ['sputnik', 'https://www.sputnik-kino.com/'],
  ['tilsiter', 'https://www.tilsiter-lichtspiele.de/'],
  ['filmkunst 66', 'https://www.filmkunst66.de/'],
  ['cinemotion', 'https://www.cinemotion-kino.de/'],
  ['fsk', 'https://www.fsk-kino.de/'],
  ['acud', 'https://acudkino.de/'],
  ['moviemento', 'https://www.moviemento.de/'],
  ['hackesche höfe', 'https://www.hoefekino.de/'],
  ['cosima', 'https://www.cosima-filmtheater.de/'],
  ['intimes', 'https://www.kino-intimes.de/'],
];

/** Best-effort ticketing URL for a cinema + film. */
export function bookingUrl(cinemaName, filmTitle, date) {
  const key = (cinemaName || '').toLowerCase();
  for (const [needle, url] of BOOKING) {
    if (key.includes(needle)) return url;
  }
  // Fallback: Google showtimes search (surfaces an in-page "Tickets" widget).
  const q = encodeURIComponent(`${cinemaName} ${filmTitle} Kino Tickets Berlin`);
  return `https://www.google.com/search?q=${q}`;
}

/** True if we have an exact (non-search) booking URL for this cinema. */
export function hasDirectBooking(cinemaName) {
  const key = (cinemaName || '').toLowerCase();
  return BOOKING.some(([needle]) => key.includes(needle));
}
