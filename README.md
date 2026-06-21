# cinema-feed

Scrapes the official Berlin cinema program from [berlin.de/kino](https://www.berlin.de/kino),
normalizes & de-duplicates it, computes a relevance score, optionally enriches via
Wikidata / TMDB / OMDb, and publishes a static `feed.json` to GitHub Pages.

Consumed by the private **Kino Berlin** iOS app. Data is public Berlin cinema info — no
user data, no API keys in the feed. Runs free on GitHub Actions (cron 2×/day) + Pages.

- Feed: `https://maam783.github.io/cinema-feed/feed.json`
- Run locally: `npm ci && node src/index.js` (writes `site/feed.json`, warms `cache/`)
- Optional env: `TMDB_API_KEY`, `OMDB_API_KEY` (ratings/budget/facts), `REQ_GAP_MS` (politeness)

See `../CLAUDE.md` in the app project for the full architecture.
