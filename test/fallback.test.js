import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cinemaForYorckName,
  versionFromTokens,
  is3DTokens,
  parseYorckFilms,
  parseKinoprogrammCinema,
  matchFilmByTitle,
  mergeTitleShowtimes,
  seedFallbackCinemas,
} from '../src/fallback.js';

test('yorck cinema names map to historic berlin.de ids', () => {
  assert.equal(cinemaForYorckName('delphi LUX')?.id, '36969');
  assert.equal(cinemaForYorckName('Blauer Stern ')?.id, '30162');
  assert.equal(cinemaForYorckName('Kino International')?.id, '30206');
  assert.equal(cinemaForYorckName('International')?.id, '30206');
  assert.equal(cinemaForYorckName('Unknown Keller')?.id, undefined);
});

test('version tokens map DF/OmU/OV and 3D', () => {
  assert.equal(versionFromTokens(['DF']), 'DE');
  assert.equal(versionFromTokens(['70mmOmU']), 'OmU');
  assert.equal(versionFromTokens(['70mmOV']), 'OV');
  assert.equal(versionFromTokens('originalfassung'), 'OV');
  assert.equal(is3DTokens(['DF', '3D']), true);
  assert.equal(is3DTokens('deutsch70-mm'), false);
});

test('parseYorckFilms reads sessions from films[]', () => {
  const extras = parseYorckFilms([
    {
      fields: {
        title: 'Die Odyssee',
        sessions: [
          {
            fields: {
              startTime: '2026-08-30T16:30:00+01:00',
              formats: ['DF'],
              cinema: { fields: { name: 'Delphi Filmpalast' } },
            },
          },
          {
            fields: {
              startTime: '2026-08-30T20:00:00+01:00',
              formats: ['OmU'],
              cinema: { fields: { name: 'Kino International' } },
            },
          },
        ],
      },
    },
  ]);
  assert.equal(extras.length, 2);
  assert.equal(extras[0].cinemaId, '30184');
  assert.equal(extras[0].time, '16:30');
  assert.equal(extras[0].date, '2026-08-30');
  assert.equal(extras[0].version, 'DE');
  assert.equal(extras[1].cinemaId, '30206');
  assert.equal(extras[1].version, 'OmU');
});

const KP_SNIP = `
<article data-kino-film data-kino-film-title="Die Odyssee">
  <div data-kino-film-day="2026-08-30">
    <div data-kino-version-row="deutsch70-mm">16:30</div>
    <div data-kino-version-row="deutsch">19:45</div>
    <div data-kino-version-row="originalfassung">20:30</div>
  </div>
  <div data-kino-film-day="2026-08-31" hidden>
    <div data-kino-version-row="ov70-mm">16:30 3D</div>
  </div>
</article>`;

test('parseKinoprogrammCinema reads title, day, version, time', () => {
  const extras = parseKinoprogrammCinema(KP_SNIP, '30241', {
    name: 'Zoo Palast',
    district: 'Charlottenburg',
  });
  assert.equal(extras.length, 4);
  assert.equal(extras[0].title, 'Die Odyssee');
  assert.equal(extras[0].cinemaId, '30241');
  assert.deepEqual(
    extras.map((s) => `${s.date} ${s.time} ${s.version} ${s.format}`),
    [
      '2026-08-30 16:30 DE 2D',
      '2026-08-30 19:45 DE 2D',
      '2026-08-30 20:30 OV 2D',
      '2026-08-31 16:30 OV 3D',
    ]
  );
});

test('mergeTitleShowtimes matches folded titles and skips dupes', () => {
  const film = {
    id: '315041',
    title: 'Die Odyssee',
    showtimes: [{ cinemaId: '30176', date: '2026-08-30', time: '20:00', version: 'DE', format: '2D' }],
    cinemaRefs: { '30176': { name: 'CinemaxX Berlin', district: 'Mitte' } },
  };
  const extras = [
    { title: 'Die Odyssee', cinemaId: '30241', date: '2026-08-30', time: '16:30', version: 'DE', format: '2D', cinemaName: 'Zoo Palast', district: 'Charlottenburg' },
    { title: 'Die Odyssee 3D', cinemaId: '30241', date: '2026-08-30', time: '16:30', version: 'DE', format: '2D', cinemaName: 'Zoo Palast' },
    { title: 'Unknown Flick', cinemaId: '30241', date: '2026-08-30', time: '10:00', version: 'DE' },
  ];
  const { added, filmsTouched } = mergeTitleShowtimes([film], extras);
  assert.equal(added, 1);
  assert.equal(filmsTouched, 1);
  assert.equal(film.showtimes.length, 2);
  assert.equal(film.cinemaRefs['30241'].name, 'Zoo Palast');
});

test('matchFilmByTitle ignores trailing 3D', () => {
  const films = [{ id: '1', title: 'Spider-Man: Brand New Day', showtimes: [] }];
  assert.equal(matchFilmByTitle('Spider-Man: Brand New Day 3D', films)?.id, '1');
  assert.equal(matchFilmByTitle('Cars', films), null);
});

test('seedFallbackCinemas does not overwrite existing entries', () => {
  const map = new Map([['30241', { id: '30241', name: 'Zoo Palast Extra' }]]);
  seedFallbackCinemas(map);
  assert.equal(map.get('30241').name, 'Zoo Palast Extra');
  assert.equal(map.get('36969').name, 'Delphi LUX');
});
