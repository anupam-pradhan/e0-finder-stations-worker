# E0 Finder Stations Worker

Cloudflare Worker backend for E0 Finder live station data.

## Cloudflare Git Deploy Settings

- Root directory: `/`
- Build command: `npm install && npm run typecheck`
- Deploy command: `npm run deploy`
- Wrangler config: `wrangler.toml`

## Required Secret

Set this Worker secret in Cloudflare before deployment:

```bash
GOOGLE_PLACES_API_KEY
```

The Flutter app must be built with:

```bash
--dart-define=STATION_API_BASE_URL=https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev
```

Do not commit the Google Places API key.