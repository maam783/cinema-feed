// Booking-link resolution for Berlin cinemas.
// berlin.de offers no per-showtime deep links, so we map the high-traffic premiere
// cinemas to their official ticketing sites, and fall back to a Google showtimes
// search (which surfaces a "Tickets" widget) for the long tail.

// substring of the berlin.de cinema name (lowercased) -> official ticketing/site URL
const BOOKING = [
  ['zoo palast', 'https://www.zoopalast-berlin.de/'],
  ['zoopalast', 'https://www.zoopalast-berlin.de/'],
  ['cinestar', 'https://www.cinestar.de/kino-berlin'],
  ['cubix', 'https://www.cinestar.de/kino/berlin-cinestar-cubix-am-alexanderplatz'],
  ['kulturbrauerei', 'https://www.cinestar.de/kino/berlin-kino-in-der-kulturbrauerei'],
  ['cinemaxx', 'https://www.cinemaxx.de/kino-berlin-potsdamer-platz'],
  ['uci', 'https://www.uci-kinowelt.de/kinos/berlin'],
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
  ['cosima', 'https://www.cosima-kino.de/'],
  ['intimes', 'https://www.intimes-kino.de/'],
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
