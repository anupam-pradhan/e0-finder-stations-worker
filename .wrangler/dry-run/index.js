var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var memoryCache = /* @__PURE__ */ new Map();
var pendingRequests = /* @__PURE__ */ new Map();
var index_default = {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    try {
      const url = new URL(request.url);
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ status: "ok", service: "e0-stations-worker" }, 200, cors);
      }
      if (request.method !== "POST") {
        return json({ error: "Use POST." }, 405, cors);
      }
      const data = await readJson(request);
      if (url.pathname === "/searchStations") {
        return await cachedJson(url, data, cors, 21600, () => searchStations(data, env), ctx);
      }
      if (url.pathname === "/searchStationsBounds") {
        return await cachedJson(url, data, cors, 21600, () => searchStationsBounds(data, env), ctx);
      }
      if (url.pathname === "/searchStationsText") {
        return await cachedJson(url, data, cors, 21600, () => searchStationsText(data, env), ctx);
      }
      if (url.pathname === "/getStationDetails") {
        return await cachedJson(url, data, cors, 86400, () => getStationDetails(data, env), ctx);
      }
      if (url.pathname === "/getPlacePhoto") {
        return json(await getPlacePhoto(data, env), 200, cors);
      }
      return json({ error: "Unknown endpoint." }, 404, cors);
    } catch (error) {
      const message = error instanceof PublicError ? error.message : "Station data is temporarily unavailable.";
      const status = error instanceof PublicError ? error.status : 503;
      const details = error instanceof PublicError ? error.details : void 0;
      if (!(error instanceof PublicError)) console.error(error);
      return json({ error: message, ...details ? { details } : {} }, status, cors);
    }
  }
};
async function searchStations(data, env) {
  const latitude = finiteNumber(data.latitude, "latitude", -90, 90);
  const longitude = finiteNumber(data.longitude, "longitude", -180, 180);
  const radiusMeters = finiteNumber(
    data.radiusMeters,
    "search radius",
    250,
    5e4
  );
  const maxResults = Math.trunc(
    finiteNumber(data.maxResults ?? 20, "result count", 1, 100)
  );
  return overpassNearbyStations(latitude, longitude, radiusMeters, maxResults);
}
__name(searchStations, "searchStations");
async function searchStationsBounds(data, env) {
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
    finiteNumber(data.maxResults ?? 80, "result count", 1, 150)
  );
  return overpassBoundsStations({ south, west, north, east }, maxResults);
}
__name(searchStationsBounds, "searchStationsBounds");
async function searchStationsText(data, env) {
  const query = typeof data.query === "string" ? data.query.trim() : "";
  if (query.length < 2 || query.length > 120) {
    throw new PublicError(400, "Search must contain 2 to 120 characters.");
  }
  const maxResults = Math.trunc(
    finiteNumber(data.maxResults ?? 20, "result count", 1, 60)
  );
  const latitude = data.latitude === void 0 ? null : finiteNumber(data.latitude, "latitude", -90, 90);
  const longitude = data.longitude === void 0 ? null : finiteNumber(data.longitude, "longitude", -180, 180);
  return overpassTextStations(query, latitude, longitude, maxResults);
}
__name(searchStationsText, "searchStationsText");
async function getStationDetails(data, env) {
  const rawPlaceId = typeof data.placeId === "string" ? data.placeId : "";
  const osmId = parseOsmPlaceId(rawPlaceId);
  if (!osmId) {
    throw new PublicError(400, "Invalid OpenStreetMap station ID.");
  }
  return overpassStationDetails(osmId);
}
__name(getStationDetails, "getStationDetails");
async function getPlacePhoto(_data, _env) {
  return { photoUri: null };
}
__name(getPlacePhoto, "getPlacePhoto");
var OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
async function overpassNearbyStations(latitude, longitude, radiusMeters, maxResults) {
  const radius = Math.min(Math.trunc(radiusMeters), 5e4);
  const query = `[out:json][timeout:2];(
    node["amenity"="fuel"](around:${radius},${latitude},${longitude});
    way["amenity"="fuel"](around:${radius},${latitude},${longitude});
    relation["amenity"="fuel"](around:${radius},${latitude},${longitude});
  );out body center qt ${maxResults};`;
  const response = await overpassRequest(query).catch(() => null);
  let stations = sanitizeOsmStations(response?.elements);
  if (stations.length === 0) {
    stations = await fetchPhotonNearby(latitude, longitude, radius / 1e3, maxResults);
  }
  return { stations: stations.slice(0, maxResults) };
}
__name(overpassNearbyStations, "overpassNearbyStations");
async function overpassBoundsStations(bounds, maxResults) {
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east].join(",");
  const query = `[out:json][timeout:2];
    nwr["amenity"="fuel"](${bbox});
    out body center qt ${maxResults};`;
  const response = await overpassRequest(query).catch(() => null);
  let stations = sanitizeOsmStations(response?.elements);
  if (stations.length === 0) {
    const centerLat = (bounds.south + bounds.north) / 2;
    const centerLon = (bounds.west + bounds.east) / 2;
    stations = await fetchPhotonNearby(centerLat, centerLon, 20, maxResults);
  }
  return { stations: stations.filter(
    (station) => typeof station.latitude === "number" && typeof station.longitude === "number" && station.latitude >= bounds.south && station.latitude <= bounds.north && station.longitude >= bounds.west && station.longitude <= bounds.east
  ).slice(0, maxResults) };
}
__name(overpassBoundsStations, "overpassBoundsStations");
async function overpassTextStations(queryText, latitude, longitude, maxResults) {
  try {
    const stations2 = await fetchPhotonText(queryText, latitude, longitude, maxResults);
    if (stations2.length > 0) return { stations: stations2 };
  } catch {
  }
  const term = escapeOverpassRegex(queryText);
  const countryPattern = "^(IN|AE|QA|SA|KW|MV|US|FR|OM|BH)$";
  const query = `[out:json][timeout:2];
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
    );out body center qt ${Math.min(maxResults * 3, 60)};`;
  const response = await overpassRequest(query).catch(() => null);
  let stations = sanitizeOsmStations(response?.elements);
  if (stations.length === 0) {
    if (response === null) throw new PublicError(503, "Station sources are temporarily unavailable.");
  } else if (latitude !== null && longitude !== null) {
    stations.sort(
      (a, b) => stationDistanceKm(a, latitude, longitude) - stationDistanceKm(b, latitude, longitude)
    );
  }
  return { stations: stations.slice(0, maxResults) };
}
__name(overpassTextStations, "overpassTextStations");
async function overpassStationDetails(osmId) {
  if (osmId.type === "node") {
    try {
      const data = await upstreamJson(
        "https://api.openstreetmap.org/api/0.6/node/" + osmId.id + ".json",
        {},
        1500
      );
      const station = sanitizeOsmStations(data.elements)[0] ?? null;
      if (station) return { station };
    } catch {
    }
  }
  const query = "[out:json][timeout:1];" + osmId.type + "(" + osmId.id + ");out body center 1;";
  const response = await overpassRequest(query, 1e3);
  return { station: sanitizeOsmStations(response.elements)[0] ?? null };
}
__name(overpassStationDetails, "overpassStationDetails");
async function upstreamJson(url, init = {}, timeoutMs = 2e3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        "User-Agent": "E0FinderBot/1.0 (+https://e0finder.com)",
        ...init.headers
      },
      signal: controller.signal
    });
    if (!response.ok) throw new PublicError(503, "Station source is unavailable.");
    return objectValue(await response.json());
  } finally {
    clearTimeout(timer);
  }
}
__name(upstreamJson, "upstreamJson");
async function overpassRequest(query, timeoutMs = 3e3) {
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const body = await upstreamJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: new URLSearchParams({ data: query })
      }, timeoutMs);
      if (Array.isArray(body.elements) && !body.remark) return body;
    } catch {
    }
  }
  throw new PublicError(503, "Station sources are temporarily unavailable.");
}
__name(overpassRequest, "overpassRequest");
async function fetchPhotonNearby(lat, lon, radiusKm, maxResults) {
  return (await fetchPhotonText("fuel", lat, lon, maxResults)).filter((station) => stationDistanceKm(station, lat, lon) <= radiusKm).sort((a, b) => stationDistanceKm(a, lat, lon) - stationDistanceKm(b, lat, lon));
}
__name(fetchPhotonNearby, "fetchPhotonNearby");
async function fetchPhotonText(query, lat, lon, maxResults) {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("osm_tag", "amenity:fuel");
  url.searchParams.set("limit", String(Math.min(maxResults, 50)));
  if (lat !== null && lon !== null) {
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
  }
  const data = await upstreamJson(url.toString());
  if (!Array.isArray(data.features)) throw new PublicError(503, "Invalid station source response.");
  return parsePhotonFeatures(data.features).slice(0, maxResults);
}
__name(fetchPhotonText, "fetchPhotonText");
function parsePhotonFeatures(features) {
  const results = [];
  for (const f of features) {
    const geom = f.geometry || {};
    const coords = geom.coordinates || [];
    const props = f.properties || {};
    if (coords.length < 2 || props.osm_key !== "amenity" || props.osm_value !== "fuel" || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1]) || Math.abs(coords[0]) > 180 || Math.abs(coords[1]) > 90) continue;
    const fLon = coords[0];
    const fLat = coords[1];
    const rawType = String(props.osm_type || "N").toUpperCase();
    const type = rawType === "W" ? "way" : rawType === "R" ? "relation" : "node";
    const osmId = props.osm_id;
    if (!Number.isSafeInteger(osmId) || osmId <= 0 || !["N", "W", "R"].includes(rawType)) continue;
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
      isOpen: null,
      openingHours: [],
      rating: null,
      reviewCount: null,
      fuelTypes: [],
      fuelPriceType: null,
      price: null,
      currency: "INR",
      priceUpdatedAt: null,
      photoResourceName: null,
      photoAttributions: []
    });
  }
  return results;
}
__name(parsePhotonFeatures, "parsePhotonFeatures");
function sanitizeOsmStations(value) {
  return (Array.isArray(value) ? value : []).map(sanitizeOsmPlace).filter((station) => station !== null);
}
__name(sanitizeOsmStations, "sanitizeOsmStations");
function sanitizeOsmPlace(value) {
  const element = objectValue(value);
  const tags = objectValue(element.tags);
  const center = objectValue(element.center);
  const latitude = typeof element.lat === "number" ? element.lat : typeof center.lat === "number" ? center.lat : null;
  const longitude = typeof element.lon === "number" ? element.lon : typeof center.lon === "number" ? center.lon : null;
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
    photoAttributions: []
  };
}
__name(sanitizeOsmPlace, "sanitizeOsmPlace");
function osmAddress(tags) {
  const parts = [
    tags["addr:housenumber"],
    tags["addr:street"],
    tags["addr:suburb"],
    tags["addr:city"],
    tags["addr:state"]
  ].filter((item) => typeof item === "string" && item.trim().length > 0);
  return parts.length > 0 ? parts.join(", ") : "Address unavailable";
}
__name(osmAddress, "osmAddress");
function osmFuelTypes(tags) {
  const fuels = [
    ["fuel:diesel", "Diesel"],
    ["fuel:petrol", "Petrol"],
    ["fuel:octane_91", "Petrol 91"],
    ["fuel:octane_95", "Petrol 95"],
    ["fuel:octane_98", "Petrol 98"],
    ["fuel:electricity", "EV charging"],
    ["fuel:cng", "CNG"],
    ["fuel:lpg", "LPG"]
  ];
  return fuels.filter(([key]) => tags[key] === "yes").map(([, label]) => label);
}
__name(osmFuelTypes, "osmFuelTypes");
function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
__name(firstText, "firstText");
function escapeOverpassRegex(value) {
  return value.replace(/[\\"\[\]().*+?^${}|]/g, "\\$&");
}
__name(escapeOverpassRegex, "escapeOverpassRegex");
function stationDistanceKm(station, latitude, longitude) {
  const stationLat = typeof station.latitude === "number" ? station.latitude : null;
  const stationLng = typeof station.longitude === "number" ? station.longitude : null;
  if (stationLat === null || stationLng === null) return Number.POSITIVE_INFINITY;
  const toRadians = /* @__PURE__ */ __name((value) => value * Math.PI / 180, "toRadians");
  const deltaLat = toRadians(stationLat - latitude);
  const deltaLng = toRadians(stationLng - longitude);
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(toRadians(latitude)) * Math.cos(toRadians(stationLat)) * Math.sin(deltaLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
__name(stationDistanceKm, "stationDistanceKm");
function parseOsmPlaceId(value) {
  const match = /^osm:(node|way|relation):(\d+)$/.exec(value);
  if (!match) return null;
  return { type: match[1], id: Number(match[2]) };
}
__name(parseOsmPlaceId, "parseOsmPlaceId");
async function readJson(request) {
  const value = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicError(400, "Invalid request.");
  }
  return value;
}
__name(readJson, "readJson");
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
__name(objectValue, "objectValue");
function finiteNumber(value, name, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new PublicError(400, "Invalid " + name + ".");
  }
  return value;
}
__name(finiteNumber, "finiteNumber");
async function cachedJson(url, data, cors, ttlSeconds, producer, ctx) {
  const keyUrl = new URL(url);
  keyUrl.pathname = "/__cache/v2" + url.pathname;
  keyUrl.search = "";
  keyUrl.searchParams.set("query", stableCacheKey(data));
  const key = keyUrl.toString();
  const now = Date.now();
  const memory = memoryCache.get(key);
  if (memory && memory.expires > now) {
    return cachedResponse(memory.body, cors, memory.expires, "HIT-MEM");
  }
  memoryCache.delete(key);
  const cacheKey = new Request(key);
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      const expires = Number(hit.headers.get("X-E0-Expires"));
      if (Number.isFinite(expires) && expires > now) {
        const body = await hit.text();
        remember(key, body, expires);
        return cachedResponse(body, cors, expires, "HIT-EDGE");
      }
    }
  } catch {
  }
  let pending = pendingRequests.get(key);
  if (!pending) {
    pending = (async () => {
      const body = await producer();
      const empty = Array.isArray(body.stations) ? body.stations.length === 0 : !body.station;
      const expires = Date.now() + Math.min(ttlSeconds, empty ? 60 : ttlSeconds) * 1e3;
      const serialized = JSON.stringify(body);
      remember(key, serialized, expires);
      const response = cachedResponse(serialized, cors, expires, "MISS");
      try {
        ctx.waitUntil(caches.default.put(cacheKey, response).catch(() => {
        }));
      } catch {
      }
      return { body: serialized, expires };
    })();
    pendingRequests.set(key, pending);
  }
  try {
    const result = await pending;
    return cachedResponse(result.body, cors, result.expires, "MISS");
  } finally {
    if (pendingRequests.get(key) === pending) pendingRequests.delete(key);
  }
}
__name(cachedJson, "cachedJson");
function remember(key, body, expires) {
  memoryCache.delete(key);
  memoryCache.set(key, { body, expires });
  while (memoryCache.size > 256) memoryCache.delete(memoryCache.keys().next().value);
}
__name(remember, "remember");
function cachedResponse(body, cors, expires, status) {
  return new Response(body, { headers: {
    ...cors,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=" + Math.max(0, Math.floor((expires - Date.now()) / 1e3)),
    "X-E0-Expires": String(expires),
    "X-E0-Cache": status
  } });
}
__name(cachedResponse, "cachedResponse");
function json(body, status, cors, cacheControl = "no-store", cacheStatus) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      ...cacheStatus ? { "X-E0-Cache": cacheStatus } : {},
      ...cors
    }
  });
}
__name(json, "json");
function stableCacheKey(data) {
  return encodeURIComponent(JSON.stringify(canonicalCacheValue(data)));
}
__name(stableCacheKey, "stableCacheKey");
function canonicalCacheValue(value) {
  if (Array.isArray(value)) return value.map(canonicalCacheValue);
  if (!value || typeof value !== "object") {
    return value;
  }
  const source = value;
  const normalized = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    normalized[key] = canonicalCacheValue(item);
  }
  return normalized;
}
__name(canonicalCacheValue, "canonicalCacheValue");
function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
__name(corsHeaders, "corsHeaders");
var PublicError = class extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
  status;
  details;
  static {
    __name(this, "PublicError");
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
