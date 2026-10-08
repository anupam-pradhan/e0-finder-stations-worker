// Reads crawled stations from the Supabase `stations` table and maps rows to
// the same station shape the OSM path returns, so the app needs no changes.

export interface SupabaseEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
}

type Bounds = {south: number; west: number; north: number; east: number};

type StationRow = {
  id: string;
  name: string | null;
  brand: string | null;
  address: string | null;
  area: string | null;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  rating: number | string | null;
  review_count: number | null;
  timing: string | null;
  phone: string | null;
};

const TIMEOUT_MS = 4000;
// PostgREST's default max-rows; dense city viewports are trimmed after sorting.
const MAX_CANDIDATES = 1000;
const GOOGLE_ID_PREFIX = "gplaces-";
const COLUMNS =
  "id,name,brand,address,area,city,state,latitude,longitude,rating,review_count,timing,phone";

export function supabaseConfigured(env: SupabaseEnv): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY);
}

export async function supabaseNearby(
  env: SupabaseEnv,
  latitude: number,
  longitude: number,
  radiusMeters: number,
  maxResults: number,
): Promise<Record<string, unknown>[]> {
  const radiusKm = radiusMeters / 1000;
  const latDelta = radiusKm / 111.32;
  const lngDelta = radiusKm / (111.32 * Math.max(Math.cos((latitude * Math.PI) / 180), 0.01));
  const rows = await rowsInBounds(env, {
    south: latitude - latDelta,
    north: latitude + latDelta,
    west: longitude - lngDelta,
    east: longitude + lngDelta,
  });
  return nearest(rows, latitude, longitude)
    .filter((row) => distanceKm(row, latitude, longitude) <= radiusKm)
    .slice(0, maxResults)
    .map(toStation);
}

export async function supabaseBounds(
  env: SupabaseEnv,
  bounds: Bounds,
  maxResults: number,
): Promise<Record<string, unknown>[]> {
  const rows = await rowsInBounds(env, bounds);
  const centerLat = (bounds.south + bounds.north) / 2;
  const centerLng = (bounds.west + bounds.east) / 2;
  return nearest(rows, centerLat, centerLng).slice(0, maxResults).map(toStation);
}

export async function supabaseText(
  env: SupabaseEnv,
  query: string,
  latitude: number | null,
  longitude: number | null,
  maxResults: number,
): Promise<Record<string, unknown>[]> {
  // Strip PostgREST filter syntax characters; wildcards are added explicitly.
  const term = query.replace(/[,()*%:."\\]/g, " ").trim();
  if (!term) return [];
  const pattern = encodeURIComponent(`*${term}*`);
  const filter = `or=(name.ilike.${pattern},brand.ilike.${pattern},city.ilike.${pattern},area.ilike.${pattern})`;
  const rows = await select(env, `${filter}&limit=${MAX_CANDIDATES}`);
  const sorted =
    latitude !== null && longitude !== null
      ? nearest(rows, latitude, longitude)
      : [...rows].sort((a, b) => (b.review_count ?? 0) - (a.review_count ?? 0));
  return sorted.slice(0, maxResults).map(toStation);
}

export async function supabaseStation(
  env: SupabaseEnv,
  placeId: string,
): Promise<Record<string, unknown> | null> {
  const ids = placeId.startsWith(GOOGLE_ID_PREFIX)
    ? [placeId]
    : [placeId, GOOGLE_ID_PREFIX + placeId];
  const idList = ids.map((id) => `"${id}"`).join(",");
  const rows = await select(env, `id=in.(${encodeURIComponent(idList)})&limit=1`);
  return rows.length > 0 ? toStation(rows[0]) : null;
}

function rowsInBounds(env: SupabaseEnv, bounds: Bounds): Promise<StationRow[]> {
  return select(
    env,
    `latitude=gte.${bounds.south}&latitude=lte.${bounds.north}` +
      `&longitude=gte.${bounds.west}&longitude=lte.${bounds.east}` +
      `&limit=${MAX_CANDIDATES}`,
  );
}

async function select(env: SupabaseEnv, filters: string): Promise<StationRow[]> {
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/stations?select=${COLUMNS}&is_active=eq.true&${filters}`,
    {
      headers: {apikey: env.SUPABASE_PUBLISHABLE_KEY ?? ""},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`Supabase stations query failed: ${response.status} ${await response.text()}`);
  }
  const body: unknown = await response.json();
  return Array.isArray(body)
    ? (body as StationRow[]).filter(
        (row) => typeof row.latitude === "number" && typeof row.longitude === "number",
      )
    : [];
}

function nearest(rows: StationRow[], latitude: number, longitude: number): StationRow[] {
  return rows
    .map((row) => ({row, distance: distanceKm(row, latitude, longitude)}))
    .sort((a, b) => a.distance - b.distance)
    .map((entry) => entry.row);
}

function distanceKm(row: StationRow, latitude: number, longitude: number): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = toRadians((row.latitude as number) - latitude);
  const deltaLng = toRadians((row.longitude as number) - longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(latitude)) *
      Math.cos(toRadians(row.latitude as number)) *
      Math.sin(deltaLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Crawled rows are stored as `gplaces-<Google place ID>`; the app and Cloud
// Functions use the bare Google place ID, which the Places API also accepts.
function publicPlaceId(id: string): string {
  return id.startsWith(GOOGLE_ID_PREFIX) ? id.slice(GOOGLE_ID_PREFIX.length) : id;
}

function toStation(row: StationRow): Record<string, unknown> {
  const placeId = publicPlaceId(row.id);
  const isGooglePlace = placeId !== row.id;
  const rating = row.rating === null ? null : Number(row.rating);
  return {
    placeId,
    name: row.name || row.brand || "Fuel station",
    brand: row.brand,
    address:
      row.address || [row.area, row.city, row.state].filter(Boolean).join(", ") || "Address unavailable",
    latitude: row.latitude,
    longitude: row.longitude,
    sourceUri:
      `https://www.google.com/maps/search/?api=1&query=${row.latitude},${row.longitude}` +
      (isGooglePlace ? `&query_place_id=${encodeURIComponent(placeId)}` : ""),
    primaryType: "gas_station",
    phone: row.phone,
    isOpen: null,
    openingHours: row.timing ? [row.timing] : [],
    rating: Number.isFinite(rating) ? rating : null,
    reviewCount: row.review_count,
    fuelTypes: [],
    fuelPriceType: null,
    price: null,
    currency: "INR",
    priceUpdatedAt: null,
    photoResourceName: null,
    photoAttributions: [],
  };
}
