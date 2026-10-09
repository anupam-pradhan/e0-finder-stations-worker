// Coverage ledger + OSM write-through for areas the catalogue doesn't cover.
// Writes use the service-role key held as a Worker SECRET (never in the app).

export interface CoverageEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

/** Google coordinates may be kept at most 30 days (Places terms). */
export const GOOGLE_POINT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A filled tile isn't re-queried upstream for this long. */
export const TILE_FRESH_MS = 30 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

export type GooglePoint = { id: string; lat: number; lng: number };

export type CoverageTile = {
  tile: string;
  checked_at: string;
  osm_count: number;
  google_place_ids: string[];
  google_points: GooglePoint[];
  google_expires_at: string | null;
};

/** ~11 km tile key from a point (0.1° grid). */
export function tileKey(latitude: number, longitude: number): string {
  return `${Math.floor(latitude * 10)}:${Math.floor(longitude * 10)}`;
}

export async function readTile(env: CoverageEnv, tile: string): Promise<CoverageTile | null> {
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  if (!env.SUPABASE_URL || !key) return null;
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/coverage_tiles?tile=eq.${encodeURIComponent(tile)}&limit=1`,
    {headers: {apikey: key}, signal: AbortSignal.timeout(TIMEOUT_MS)},
  );
  if (!response.ok) return null; // ledger table not deployed yet
  const rows = (await response.json()) as CoverageTile[];
  return rows[0] ?? null;
}

export function isFresh(tile: CoverageTile, now: number): boolean {
  return now - Date.parse(tile.checked_at) < TILE_FRESH_MS;
}

/** Stored Google points still within their 30-day allowance. */
export function liveGooglePoints(tile: CoverageTile, now: number): GooglePoint[] {
  if (!tile.google_expires_at || Date.parse(tile.google_expires_at) <= now) return [];
  return Array.isArray(tile.google_points) ? tile.google_points : [];
}

/** Persists OSM pumps (permanent) and the tile ledger (Google ids + 30-day coords). */
export async function persistCoverage(
  env: CoverageEnv,
  tile: string,
  osmStations: Record<string, unknown>[],
  googleStations: Record<string, unknown>[],
  now: number,
): Promise<void> {
  const service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !service) return;
  const headers = {
    apikey: service,
    Authorization: `Bearer ${service}`,
    "Content-Type": "application/json",
  };

  if (osmStations.length > 0) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/ingest_osm_stations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        stations: osmStations.map((station) => ({
          id: station.placeId,
          name: station.name,
          brand: inferBrand(String(station.name ?? "")),
          address: station.address,
          latitude: station.latitude,
          longitude: station.longitude,
        })),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  // Google terms: coordinates may be kept at most 30 days. Drop any expired
  // ones on every write so no scheduler (pg_cron) is required.
  await fetch(
    `${env.SUPABASE_URL}/rest/v1/coverage_tiles?google_expires_at=lt.${encodeURIComponent(
      new Date(now).toISOString(),
    )}`,
    {
      method: "PATCH",
      headers: {...headers, Prefer: "return=minimal"},
      body: JSON.stringify({google_points: [], google_expires_at: null}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  ).catch(() => undefined);

  const points: GooglePoint[] = googleStations
    .filter((s) => typeof s.placeId === "string")
    .map((s) => ({id: String(s.placeId), lat: Number(s.latitude), lng: Number(s.longitude)}));
  await fetch(`${env.SUPABASE_URL}/rest/v1/coverage_tiles?on_conflict=tile`, {
    method: "POST",
    headers: {...headers, Prefer: "resolution=merge-duplicates,return=minimal"},
    body: JSON.stringify({
      tile,
      checked_at: new Date(now).toISOString(),
      osm_count: osmStations.length,
      google_place_ids: points.map((p) => p.id),
      google_points: points,
      google_expires_at: points.length ? new Date(now + GOOGLE_POINT_TTL_MS).toISOString() : null,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

const BRANDS: [RegExp, string][] = [
  [/indian\s?oil|\biocl?\b/i, "IndianOil"],
  [/bharat|\bbpcl?\b/i, "BPCL"],
  [/hindustan|\bhpcl?\b|\bhp\b/i, "HPCL"],
  [/jio[\s-]?bp|reliance/i, "Jio-bp"],
  [/nayara|essar/i, "Nayara"],
  [/shell/i, "Shell"],
];

export function inferBrand(name: string): string {
  for (const [pattern, brand] of BRANDS) {
    if (pattern.test(name)) return brand;
  }
  return "Fuel Station";
}
