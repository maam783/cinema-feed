import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseFilm, parseCinema, mergeCinemaShowtimes, merge3DVariants, strip3DTitle, is3DTitle } from '../src/berlin.js';
import { parseGermanDate, parseGermanLongDate, clean } from '../src/util.js';
import { normalizeCountry, countryFilterOrder, computeRelevance, generateFacts } from '../src/relevance.js';
import { bookingUrl, hasDirectBooking } from '../src/cinemas.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(__dir, '../fixtures/film_314067.html');
const kinoFixture = resolve(__dir, '../fixtures/kino_30157.html');

test('parseGermanDate handles 2- and 4-digit years', () => {
  assert.equal(parseGermanDate('18.06.26'), '2026-06-18');
  assert.equal(parseGermanDate('So, 21.06.2026'), '2026-06-21');
  assert.equal(parseGermanDate('garbage'), null);
});

test('parseGermanLongDate parses German month names', () => {
  assert.equal(parseGermanLongDate('18. Juni 2026'), '2026-06-18');
  assert.equal(parseGermanLongDate('1. Dezember 2025'), '2025-12-01');
});

test('normalizeCountry maps + falls back', () => {
  assert.equal(normalizeCountry('USA').code, 'US');
  assert.equal(normalizeCountry('Deutschland').code, 'DE');
  assert.equal(normalizeCountry('USA / Deutschland').code, 'US'); // first recognized
  assert.equal(normalizeCountry('Burkina Faso').code, 'XX');
  assert.equal(normalizeCountry(null).code, 'XX');
});

test('countryFilterOrder is sorted by relevance, USA first', () => {
  const order = countryFilterOrder();
  assert.equal(order[0].code, 'US');
  const weights = order.map((c) => c.weight);
  assert.deepEqual(weights, [...weights].sort((a, b) => b - a));
});

test('computeRelevance is bounded 0..100 and rewards footprint', () => {
  const big = { cinemaIds: Array(40), showtimeCount: 400, countryInfo: { weight: 15 }, releaseDate: '2026-06-20' };
  const small = { cinemaIds: ['a'], showtimeCount: 2, countryInfo: { weight: 3 } };
  const rb = computeRelevance(big, { now: '2026-06-21' }).score;
  const rs = computeRelevance(small, { now: '2026-06-21' }).score;
  assert.ok(rb >= 0 && rb <= 100);
  assert.ok(rs >= 0 && rs <= 100);
  assert.ok(rb > rs, 'wide release should outrank a niche film');
});

test('generateFacts produces template facts from structured data', () => {
  const facts = generateFacts({
    collection: 'Toy Story', budget: 250e6, boxOffice: 900e6,
    director: 'X', cast: ['A', 'B'], runtime: 100,
  });
  assert.ok(facts.some((f) => f.includes('Toy Story')));
  assert.ok(facts.some((f) => f.includes('budget')));
  assert.ok(facts.length <= 4);
});

test('bookingUrl: direct for known chains, Google fallback otherwise', () => {
  assert.ok(bookingUrl('Zoo Palast', 'X', '').includes('zoopalast'));
  assert.ok(bookingUrl('CinemaxX Berlin', 'X', '').includes('cinemaxx'));
  assert.ok(bookingUrl('Obskures Kellerkino', 'Film', '').includes('google.com/search'));
  assert.equal(hasDirectBooking('Yorck'), true);
  assert.equal(hasDirectBooking('Obskures Kellerkino'), false);
});

test('parseFilm extracts fields + showtimes from fixture', { skip: !existsSync(fixture) }, () => {
  const film = parseFilm(readFileSync(fixture, 'utf8'), '314067');
  assert.equal(film.title, 'Backrooms');
  assert.equal(film.country, 'USA');
  assert.equal(film.runtime, 105);
  assert.equal(film.fsk, 16);
  assert.equal(film.releaseDate, '2026-06-18');
  assert.ok(film.cast.includes('Renate Reinsve'));
  // poster is read from the page (Print2 preferred), not blindly guessed
  assert.equal(film.poster, 'https://www.berlin.de/kino/_img/filmbilder/p_314067_Print2.jpg');
  assert.ok(film.showtimes.length > 100, 'popular film has many showtimes');
  // versions detected and constrained
  const versions = new Set(film.showtimes.map((s) => s.version));
  for (const v of versions) assert.ok(['DE', 'OmU', 'OV'].includes(v));
  // every showtime has a parseable date + HH:MM time
  for (const s of film.showtimes.slice(0, 50)) {
    assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(s.time, /^\d{2}:\d{2}$/);
  }
});

test('parseCinema reads address and film showtimes (skips transit accordion)', { skip: !existsSync(kinoFixture) }, () => {
  const c = parseCinema(readFileSync(kinoFixture, 'utf8'), '30157');
  assert.equal(c.name, 'Astra-Filmpalast');
  assert.match(c.address, /Sterndamm/);
  assert.ok(c.showtimes.length > 20, 'cinema page lists many screenings');
  assert.ok(c.showtimes.every((s) => s.cinemaId === '30157'));
  assert.ok(c.showtimes.every((s) => s.filmId));
  const backrooms = c.showtimes.filter((s) => s.filmId === '314067');
  const sw3d = c.showtimes.filter((s) => s.filmId === '314406');
  assert.ok(backrooms.length >= 8);
  assert.ok(sw3d.length >= 1);
  assert.ok(backrooms.some((s) => s.date === '2026-06-21' && s.time === '17:30'));
  assert.ok(!backrooms.some((s) => s.filmId === '314406'), '2D and 3D stay on their own film ids');
});

test('mergeCinemaShowtimes fills holes and does not duplicate', () => {
  const film = {
    id: '315264',
    showtimes: [{ cinemaId: '30176', date: '2026-08-20', time: '20:00', version: 'DE' }],
    cinemaRefs: { '30176': { name: 'CinemaxX Berlin', district: 'Mitte' } },
  };
  const extras = [
    { filmId: '315264', cinemaId: '30241', date: '2026-08-20', time: '12:15', version: 'DE', cinemaName: 'Zoo Palast', district: 'Charlottenburg' },
    { filmId: '315264', cinemaId: '30176', date: '2026-08-20', time: '20:00', version: 'DE' }, // already on film page
    { filmId: '999999', cinemaId: '30241', date: '2026-08-20', time: '12:15', version: 'DE' }, // unknown film
  ];
  const { added, filmsTouched } = mergeCinemaShowtimes([film], extras);
  assert.equal(added, 1);
  assert.equal(filmsTouched, 1);
  assert.equal(film.showtimes.length, 2);
  assert.ok(film.showtimes.some((s) => s.cinemaId === '30241' && s.time === '12:15'));
  assert.equal(film.cinemaRefs['30241'].name, 'Zoo Palast');
});

test('strip3DTitle only strips a trailing 3D token', () => {
  assert.equal(strip3DTitle('Spider-Man: Brand New Day 3D'), 'Spider-Man: Brand New Day');
  assert.equal(strip3DTitle('Vaiana (Live Action) 3D'), 'Vaiana (Live Action)');
  assert.equal(strip3DTitle('Toy Story 3'), 'Toy Story 3');
  assert.equal(is3DTitle('Toy Story 3'), false);
  assert.equal(is3DTitle('Hoppers 3D'), true);
});

test('merge3DVariants folds 2D+3D into one film and leaves 3D-only alone', () => {
  const twoD = {
    id: '315264',
    title: 'Spider-Man: Brand New Day',
    year: 2026,
    showtimes: [{ cinemaId: '30241', date: '2026-08-21', time: '13:15', version: 'DE' }],
    cinemaRefs: { '30241': { name: 'Zoo Palast', district: 'Charlottenburg' } },
  };
  const threeD = {
    id: '315274',
    title: 'Spider-Man: Brand New Day 3D',
    year: 2026,
    showtimes: [{ cinemaId: '30241', date: '2026-08-21', time: '14:10', version: 'DE' }],
    cinemaRefs: { '30241': { name: 'Zoo Palast', district: 'Charlottenburg' } },
  };
  const only3D = {
    id: '278274',
    title: 'Antarctica 3D',
    year: 2012,
    showtimes: [{ cinemaId: '1', date: '2026-08-21', time: '18:00', version: 'DE' }],
  };
  const { films, collapsed } = merge3DVariants([twoD, threeD, only3D]);
  assert.equal(collapsed, 1);
  assert.equal(films.length, 2);
  const spider = films.find((f) => f.id === '315264');
  const ice = films.find((f) => f.id === '278274');
  assert.ok(spider);
  assert.deepEqual(spider.aliasIds, ['315274']);
  assert.equal(spider.showtimes.length, 2);
  assert.ok(spider.showtimes.some((s) => s.time === '13:15' && s.format === '2D'));
  assert.ok(spider.showtimes.some((s) => s.time === '14:10' && s.format === '3D'));
  assert.equal(ice.title, 'Antarctica 3D');
  assert.equal(ice.showtimes[0].format, '3D');
});
