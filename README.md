# E0 Finder Stations Worker

Cloudflare Worker backend for E0 Finder live station data.

Station search uses OpenStreetMap data through the Overpass API. No Google Maps or Google Places API key is required for station discovery.

## Cloudflare Git Deploy Settings

- Root directory: `/`
- Build command: `npm install && npm run typecheck`
- Deploy command: `npm run deploy`
- Wrangler config: `wrangler.toml`

## Flutter App Build

The Flutter app should point station data to this Worker:

```bash
--dart-define=STATION_API_BASE_URL=https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev
```