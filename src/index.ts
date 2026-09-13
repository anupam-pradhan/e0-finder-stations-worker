export interface Env {
  ALLOWED_ORIGIN?: string;
}

type UnknownMap = Record<string, unknown>;

// High-speed in-memory edge cache (0 ms response for repeated local queries)
const memoryCache = new Map<string, {expires: number; body: string}>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(env);
    if (request.method === "OPTIONS") {
      return new Response(null, {status: 204, headers: cors});
    }

    try {
      const url = new URL(request.url);
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({status: "ok", service: "e0-stations-worker"}, 200, cors);
      }

      if (request.method !== "POST") {
        return json({error: "Use POST."}, 405, cors);
      }

      const data = await readJson(request);
      if (url.pathname === "/searchStations") {
        return cachedJson(url.pathname, data, cors, 21600, () => searchStations(data, env));
      }
      if (url.pathname === "/searchStationsBounds") {
        return cachedJson(url.pathname, data, cors, 21600, () => searchStationsBounds(data, env));
      }
      if (url.pathname === "/searchStationsText") {
        return cachedJson(url.pathname, data, cors, 21600, () => searchStationsText(data, env));
      }
      if (url.pathname === "/getStationDetails") {
        return cachedJson(url.pathname, data, cors, 86400, () => getStationDetails(data, env));
      }
      if (url.pathname === "/getPlacePhoto") {
        return json(await getPlacePhoto(data, env), 200, cors);
      }
      return json({error: "Unknown endpoint."}, 404, cors);
    } catch (error) {
      const message =
        error instanceof PublicError
          ? error.message
          : "Station data is temporarily unavailable.";
      const status = error instanceof PublicError ? error.status : 503;
      const details = error instanceof PublicError ? error.details : undefined;
      if (!(error instanceof PublicError)) console.error(error);
      return json({error: message, ...(details ? {details} : {})}, status, cors);
    }
  },
};

async function searchStations(data: UnknownMap, env: Env): Promise<UnknownMap> {
  const latitude = finiteNumber(data.latitude, "latitude", -90, 90);
  const longitude = finiteNumber(data.longitude, "longitude", -180, 180);
  const radiusMeters = finiteNumber(
    data.radiusMeters,
    "search radius",
    250,
    50000,
  );
  const maxResults = Math.trunc(
    finiteNumber(data.maxResults ?? 20, "result count", 1, 100),
  );
  return overpassNearbyStations(latitude, longitude, radiusMeters, maxResults);
}

async function searchStationsBounds(
  data: UnknownMap,
  env: Env,
): Promise<UnknownMap> {
  const south = finiteNumber(data.south, "south latitude", -90, 90);
  const west = finiteNumber(data.west, "west longitude", -180, 180);
  const north = finiteNumber(data.north, "north latitude", -90, 90);
  const east = finiteNumber(data.east, "east longitude", -180, 180);
  if (south >= north) {
    throw new PublicError(400, "Invalid viewport latitude range.");
  }
  if (west >= east) {
    throw new PublicError(400, "Invalid viewport longitude range.");
  }
  const maxResults = Math.trunc(
    finiteNumber(data.maxResults ?? 80, "result count", 1, 150),
  );
  return overpassBoundsStations({south, west, north, east}, maxResults);
}

async function searchStationsText(
  data: UnknownMap,
  env: Env,
): Promise<UnknownMap> {
  const query = typeof data.query === "string" ? data.query.trim() : "";
  if (query.length < 2 || query.length > 120) {
    throw new PublicError(400, "Search must contain 2 to 120 characters.");
  }
  const maxResults = Math.trunc(
    finiteNumber(data.maxResults ?? 20, "result count", 1, 60),
  );
  const latitude =
    data.latitude === undefined
      ? null
      : finiteNumber(data.latitude, "latitude", -90, 90);
  const longitude =
    data.longitude === undefined
      ? null
      : finiteNumber(data.longitude, "longitude", -180, 180);
  return overpassTextStations(query, latitude, longitude, maxResults);
}

async function getStationDetails(
  data: UnknownMap,
  env: Env,
): Promise<UnknownMap> {
  const rawPlaceId = typeof data.placeId === "string" ? data.placeId : "";
  const osmId = parseOsmPlaceId(rawPlaceId);
  if (!osmId) {
    throw new PublicError(400, "Invalid OpenStreetMap station ID.");
  }
  return overpassStationDetails(osmId);
}

async function getPlacePhoto(_data: UnknownMap, _env: Env): Promise<UnknownMap> {
  return {photoUri: null};
}

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

async function overpassNearbyStations(
  latitude: number,
  longitude: number,
  radiusMeters: number,
  maxResults: number,
): Promise<UnknownMap> {
  const radius = Math.min(Math.trunc(radiusMeters), 50000);
  const query = `[out:json][timeout:8];(
    node["amenity"="fuel"](around:${radius},${latitude},${longitude});
    way["amenity"="fuel"](around:${radius},${latitude},${longitude});
    relation["amenity"="fuel"](around:${radius},${latitude},${longitude});
  );out tags center qt ${maxResults};`;
  const response = await overpassRequest(query);
  let stations = sanitizeOsmStations(response.elements);
  if (stations.length === 0) {
    stations = await fetchPhotonNearby(latitude, longitude, radius / 1000, maxResults);
  }
  return {stations: stations.slice(0, maxResults)};
}

type Bounds = {south: number; west: number; north: number; east: number};

async function overpassBoundsStations(
  bounds: Bounds,
  maxResults: number,
): Promise<UnknownMap> {
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east].join(",");
  const query = `[out:json][timeout:8];
    nwr["amenity"="fuel"](${bbox});
    out tags center qt ${maxResults};`;
  const response = await overpassRequest(query);
  let stations = sanitizeOsmStations(response.elements);
  if (stations.length === 0) {
    const centerLat = (bounds.south + bounds.north) / 2;
    const centerLon = (bounds.west + bounds.east) / 2;
    stations = await fetchPhotonNearby(centerLat, centerLon, 20, maxResults);
  }
  return {stations: stations.slice(0, maxResults)};
}

async function overpassTextStations(
  queryText: string,
  latitude: number | null,
  longitude: number | null,
  maxResults: number,
): Promise<UnknownMap> {
  const term = escapeOverpassRegex(queryText);
  const countryPattern = "^(IN|AE|QA|SA|KW|MV|US|FR|OM|BH)$";
  const query = `[out:json][timeout:10];
    area["ISO3166-1"~"${countryPattern}"]["admin_level"="2"]->.searchCountries;
    (
      node["amenity"="fuel"]["name"~"${term}",i](area.searchCountries);
      way["amenity"="fuel"]["name"~"${term}",i](area.searchCountries);
      relation["amenity"="fuel"]["name"~"${term}",i](area.searchCountries);
      node["amenity"="fuel"]["brand"~"${term}",i](area.searchCountries);
      way["amenity"="fuel"]["brand"~"${term}",i](area.searchCountries);
      relation["amenity"="fuel"]["brand"~"${term}",i](area.searchCountries);
      node["amenity"="fuel"]["operator"~"${term}",i](area.searchCountries);
      way["amenity"="fuel"]["operator"~"${term}",i](area.searchCountries);
      relation["amenity"="fuel"]["operator"~"${term}",i](area.searchCountries);
    );out tags center qt ${Math.min(maxResults * 3, 60)};`;
  const response = await overpassRequest(query);
  let stations = sanitizeOsmStations(response.elements);
  if (stations.length === 0) {
    stations = await fetchPhotonText(queryText, latitude, longitude, maxResults);
  } else if (latitude !== null && longitude !== null) {
    stations.sort(
      (a, b) => stationDistanceKm(a, latitude, longitude) - stationDistanceKm(b, latitude, longitude),
    );
  }
  return {stations: stations.slice(0, maxResults)};
}

async function overpassStationDetails(osmId: OsmPlaceId): Promise<UnknownMap> {
  // Direct OSM API query for fastest single node/way lookup
  try {
    const res = await fetch(`https://api.openstreetmap.org/api/0.6/${osmId.type}/${osmId.id}.json`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; E0FinderBot/1.0; +https://e0finder.com)" },
    });
    if (res.ok) {
      const data: any = await res.json();
      const station = sanitizeOsmStations(data.elements)[0] ?? null;
      if (station) return {station};
    }
  } catch {}

  const query = `[out:json][timeout:8];${osmId.type}(${osmId.id});out tags center 1;`;
  const response = await overpassRequest(query);
  const station = sanitizeOsmStations(response.elements)[0] ?? null;
  return {station};
}

async function overpassRequest(query: string): Promise<UnknownMap> {
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          "User-Agent": "Mozilla/5.0 (compatible; E0FinderBot/1.0; +https://e0finder.com)",
        },
        body: new URLSearchParams({data: query}),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) continue;
      const bodyText = await response.text();
      const body = bodyText ? objectValue(JSON.parse(bodyText)) : {};
      if (Array.isArray(body.elements)) {
        return body;
      }
    } catch {}
  }
  return {elements: []};
}

async function fetchPhotonNearby(
  lat: number,
  lon: number,
  radiusKm: number,
  maxResults: number,
): Promise<UnknownMap[]> {
  try {
    const url = `https://photon.komoot.io/api/?q=fuel&lat=${lat}&lon=${lon}&limit=${maxResults}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; E0FinderBot/1.0; +https://e0finder.com)" },
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    return parsePhotonFeatures(data.features || []);
  } catch {
    return [];
  }
}

async function fetchPhotonText(
  query: string,
  lat: number | null,
  lon: number | null,
  maxResults: number,
): Promise<UnknownMap[]> {
  try {
    let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=${maxResults}`;
    if (lat !== null && lon !== null) {
      url += `&lat=${lat}&lon=${lon}`;
    }
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; E0FinderBot/1.0; +https://e0finder.com)" },
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    return parsePhotonFeatures(data.features || []);
  } catch {
    return [];
  }
}

function parsePhotonFeatures(features: any[]): UnknownMap[] {
  const results: UnknownMap[] = [];
  for (const f of features) {
    const geom = f.geometry || {};
    const coords = geom.coordinates || [];
    const props = f.properties || {};
    if (coords.length < 2) continue;
    const fLon = coords[0];
    const fLat = coords[1];
    const rawType = String(props.osm_type || "N").toUpperCase();
    const type = rawType === "W" ? "way" : rawType === "R" ? "relation" : "node";
    const osmId = props.osm_id;
    if (!osmId) continue;
    const name = props.name || props.street || "Fuel Station";
    const address = [props.street, props.city, props.state, props.country].filter(Boolean).join(", ") || `Near ${name}`;
    results.push({
      placeId: `osm:${type}:${osmId}`,
      name,
      address,
      latitude: fLat,
      longitude: fLon,
      sourceUri: `https://www.openstreetmap.org/${type}/${osmId}`,
      primaryType: "gas_station",
      phone: null,
      isOpen: true,
      openingHours: [],
      rating: null,
      reviewCount: null,
      fuelTypes: ["Petrol", "Diesel"],
      fuelPriceType: null,
      price: null,
      currency: "INR",
      priceUpdatedAt: null,
      photoResourceName: null,
      photoAttributions: [],
    });
  }
  return results;
}

function sanitizeOsmStations(value: unknown): UnknownMap[] {
  return (Array.isArray(value) ? value : [])
    .map(sanitizeOsmPlace)
    .filter((station): station is UnknownMap => station !== null);
}

function sanitizeOsmPlace(value: unknown): UnknownMap | null {
  const element = objectValue(value);
  const tags = objectValue(element.tags);
  const center = objectValue(element.center);
  const latitude =
    typeof element.lat === "number"
      ? element.lat
      : typeof center.lat === "number"
        ? center.lat
        : null;
  const longitude =
    typeof element.lon === "number"
      ? element.lon
      : typeof center.lon === "number"
        ? center.lon
        : null;
  const type = typeof element.type === "string" ? element.type : "";
  const id = typeof element.id === "number" ? Math.trunc(element.id) : null;
  if (!type || id === null || latitude === null || longitude === null) return null;

  const name = firstText(tags.name, tags.brand, tags.operator) || "Fuel station";
  return {
    placeId: `osm:${type}:${id}`,
    name,
    address: osmAddress(tags),
    latitude,
    longitude,
    sourceUri: `https://www.openstreetmap.org/${type}/${id}`,
    primaryType: "gas_station",
    phone: firstText(tags.phone, tags["contact:phone"]),
    isOpen: null,
    openingHours: typeof tags.opening_hours === "string" ? [tags.opening_hours] : [],
    rating: null,
    reviewCount: null,
    fuelTypes: osmFuelTypes(tags),
    fuelPriceType: null,
    price: null,
    currency: "INR",
    priceUpdatedAt: null,
    photoResourceName: null,
    photoAttributions: [],
  };
}

function osmAddress(tags: UnknownMap): string {
  const parts = [
    tags["addr:housenumber"],
    tags["addr:street"],
    tags["addr:suburb"],
    tags["addr:city"],
    tags["addr:state"],
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return parts.length > 0 ? parts.join(", ") : "Address unavailable";
}

function osmFuelTypes(tags: UnknownMap): string[] {
  const fuels = [
    ["fuel:diesel", "Diesel"],
    ["fuel:petrol", "Petrol"],
    ["fuel:octane_91", "Petrol 91"],
    ["fuel:octane_95", "Petrol 95"],
    ["fuel:octane_98", "Petrol 98"],
    ["fuel:electricity", "EV charging"],
    ["fuel:cng", "CNG"],
    ["fuel:lpg", "LPG"],
  ];
  return fuels
    .filter(([key]) => tags[key] === "yes")
    .map(([, label]) => label);
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function escapeOverpassRegex(value: string): string {
  return value.replace(/[\\"\[\]().*+?^${}|]/g, "\\$&");
}

function stationDistanceKm(station: UnknownMap, latitude: number, longitude: number): number {
  const stationLat = typeof station.latitude === "number" ? station.latitude : null;
  const stationLng = typeof station.longitude === "number" ? station.longitude : null;
  if (stationLat === null || stationLng === null) return Number.POSITIVE_INFINITY;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = toRadians(stationLat - latitude);
  const deltaLng = toRadians(stationLng - longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(latitude)) *
      Math.cos(toRadians(stationLat)) *
      Math.sin(deltaLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type OsmPlaceId = {type: "node" | "way" | "relation"; id: number};

function parseOsmPlaceId(value: string): OsmPlaceId | null {
  const match = /^osm:(node|way|relation):(\d+)$/.exec(value);
  if (!match) return null;
  return {type: match[1] as OsmPlaceId["type"], id: Number(match[2])};
}

async function readJson(request: Request): Promise<UnknownMap> {
  const value = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicError(400, "Invalid request.");
  }
  return value as UnknownMap;
}

function objectValue(value: unknown): UnknownMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownMap)
    : {};
}

function finiteNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new PublicError(400, "Invalid " + name + ".");
  }
  return value;
}

async function cachedJson(
  pathname: string,
  data: UnknownMap,
  cors: HeadersInit,
  ttlSeconds: number,
  producer: () => Promise<UnknownMap>,
): Promise<Response> {
  const cacheKeyStr = pathname + "?" + stableCacheKey(data);
  const now = Date.now();

  // 1. Check in-memory edge cache (0 ms response)
  const memCached = memoryCache.get(cacheKeyStr);
  if (memCached && memCached.expires > now) {
    return new Response(memCached.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${ttlSeconds}`,
        "X-E0-Cache": "HIT-MEM",
        ...cors,
      },
    });
  }

  // 2. Defensive Cloudflare Edge Cache API (safe for all domains)
  let cacheKey: Request | null = null;
  try {
    if (typeof caches !== "undefined" && caches.default) {
      cacheKey = new Request("https://stations-edge.e0finder.com" + cacheKeyStr, {method: "GET"});
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        const bodyText = await cached.text();
        memoryCache.set(cacheKeyStr, {expires: now + (ttlSeconds * 1000), body: bodyText});
        return new Response(bodyText, {
          status: cached.status,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${ttlSeconds}`,
            "X-E0-Cache": "HIT-EDGE",
            ...cors,
          },
        });
      }
    }
  } catch {}

  // 3. Upstream Producer with Fallback
  const body = await producer();
  const serialized = JSON.stringify(body);

  // Store in memory cache
  memoryCache.set(cacheKeyStr, {expires: now + (ttlSeconds * 1000), body: serialized});
  if (memoryCache.size > 2000) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey) memoryCache.delete(oldestKey);
  }

  const response = json(body, 200, cors, `public, max-age=${ttlSeconds}`, "MISS");

  // Store in Cloudflare zone cache if available
  if (cacheKey) {
    try {
      await caches.default.put(cacheKey, response.clone());
    } catch {}
  }

  return response;
}

function json(
  body: unknown,
  status: number,
  cors: HeadersInit,
  cacheControl = "no-store",
  cacheStatus?: "HIT" | "MISS",
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      ...(cacheStatus ? {"X-E0-Cache": cacheStatus} : {}),
      ...cors,
    },
  });
}

function stableCacheKey(data: UnknownMap): string {
  return encodeURIComponent(JSON.stringify(canonicalCacheValue(data)));
}

function canonicalCacheValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCacheValue);
  if (!value || typeof value !== "object") {
    return typeof value === "number" ? Math.round(value * 10000) / 10000 : value;
  }
  const source = value as UnknownMap;
  const normalized: UnknownMap = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    normalized[key] = typeof item === "number" ? canonicalNumber(key, item) : canonicalCacheValue(item);
  }
  return normalized;
}

function canonicalNumber(key: string, value: number): number {
  if (!Number.isFinite(value)) return value;
  if (["latitude", "longitude", "south", "west", "north", "east"].includes(key)) {
    return Math.round(value * 1000) / 1000;
  }
  if (key === "radiusMeters") return Math.round(value / 1000) * 1000;
  return Math.round(value * 10000) / 10000;
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

class PublicError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: UnknownMap,
  ) {
    super(message);
  }
}
