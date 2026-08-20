export interface Env {
  ALLOWED_ORIGIN?: string;
}

type UnknownMap = Record<string, unknown>;


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(env);
    if (request.method === "OPTIONS") {
      return new Response(null, {status: 204, headers: cors});
    }

    try {
      const url = new URL(request.url);
      if (request.method !== "POST") {
        return json({error: "Use POST."}, 405, cors);
      }


      const data = await readJson(request);
      if (url.pathname === "/searchStations") {
        return json(await searchStations(data, env), 200, cors);
      }
      if (url.pathname === "/searchStationsBounds") {
        return json(await searchStationsBounds(data, env), 200, cors);
      }
      if (url.pathname === "/searchStationsText") {
        return json(await searchStationsText(data, env), 200, cors);
      }
      if (url.pathname === "/getStationDetails") {
        return json(await getStationDetails(data, env), 200, cors);
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
    finiteNumber(data.maxResults ?? 20, "result count", 1, 20),
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
    finiteNumber(data.maxResults ?? 80, "result count", 1, 100),
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
    finiteNumber(data.maxResults ?? 20, "result count", 1, 20),
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

async function overpassNearbyStations(
  latitude: number,
  longitude: number,
  radiusMeters: number,
  maxResults: number,
): Promise<UnknownMap> {
  const radius = Math.min(Math.trunc(radiusMeters), 50000);
  const query = `[out:json][timeout:15];(
    node["amenity"="fuel"](around:${radius},${latitude},${longitude});
    way["amenity"="fuel"](around:${radius},${latitude},${longitude});
    relation["amenity"="fuel"](around:${radius},${latitude},${longitude});
  );out tags center qt ${maxResults};`;
  const response = await overpassRequest(query);
  return {stations: sanitizeOsmStations(response.elements).slice(0, maxResults)};
}

type Bounds = {south: number; west: number; north: number; east: number};

async function overpassBoundsStations(
  bounds: Bounds,
  maxResults: number,
): Promise<UnknownMap> {
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east].join(",");
  const query = `[out:json][timeout:20];
    nwr["amenity"="fuel"](${bbox});
    out tags center qt ${maxResults};`;
  const response = await overpassRequest(query);
  return {stations: sanitizeOsmStations(response.elements).slice(0, maxResults)};
}

async function overpassTextStations(
  queryText: string,
  latitude: number | null,
  longitude: number | null,
  maxResults: number,
): Promise<UnknownMap> {
  const term = escapeOverpassRegex(queryText);
  const spatialFilter =
    latitude !== null && longitude !== null
      ? `(around:25000,${latitude},${longitude})`
      : `(area.india)`;
  const areaPrefix =
    latitude !== null && longitude !== null
      ? ""
      : 'area["ISO3166-1"="IN"]["admin_level"="2"]->.india;';
  const query = `[out:json][timeout:20];${areaPrefix}(
    node["amenity"="fuel"]["name"~"${term}",i]${spatialFilter};
    way["amenity"="fuel"]["name"~"${term}",i]${spatialFilter};
    relation["amenity"="fuel"]["name"~"${term}",i]${spatialFilter};
    node["amenity"="fuel"]["brand"~"${term}",i]${spatialFilter};
    way["amenity"="fuel"]["brand"~"${term}",i]${spatialFilter};
    relation["amenity"="fuel"]["brand"~"${term}",i]${spatialFilter};
    node["amenity"="fuel"]["operator"~"${term}",i]${spatialFilter};
    way["amenity"="fuel"]["operator"~"${term}",i]${spatialFilter};
    relation["amenity"="fuel"]["operator"~"${term}",i]${spatialFilter};
  );out tags center qt ${maxResults};`;
  const response = await overpassRequest(query);
  return {stations: sanitizeOsmStations(response.elements).slice(0, maxResults)};
}

async function overpassStationDetails(osmId: OsmPlaceId): Promise<UnknownMap> {
  const query = `[out:json][timeout:10];${osmId.type}(${osmId.id});out tags center 1;`;
  const response = await overpassRequest(query);
  const station = sanitizeOsmStations(response.elements)[0] ?? null;
  return {station};
}

async function overpassRequest(query: string): Promise<UnknownMap> {
  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      "User-Agent": "E0 Finder station backend (https://e0-finder.app)",
    },
    body: new URLSearchParams({data: query}),
  });
  const bodyText = await response.text();
  let body: UnknownMap = {};
  try {
    body = bodyText ? objectValue(JSON.parse(bodyText)) : {};
  } catch {
    if (response.ok) {
      throw new PublicError(
        503,
        "OpenStreetMap station data is temporarily unavailable.",
        {osmStatus: response.status, osmError: bodyText.slice(0, 500)},
      );
    }
  }
  if (response.ok) return body;
  throw new PublicError(
    response.status === 429 ? 429 : 503,
    "OpenStreetMap station data is temporarily unavailable.",
    {osmStatus: response.status, osmError: bodyText.slice(0, 500)},
  );
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

type OsmPlaceId = {type: "node" | "way" | "relation"; id: number};

function parseOsmPlaceId(value: string): OsmPlaceId | null {
  const match = /^osm:(node|way|relation):(\d+)$/.exec(value);
  if (!match) return null;
  return {type: match[1] as OsmPlaceId["type"], id: Number(match[2])};
}

function parseFuelOptions(value: unknown): {
  fuelTypes: string[];
  fuelPriceType: string | null;
  price: number | null;
  currency: string;
  priceUpdatedAt: string | null;
} {
  const fuelOptions = objectValue(value);
  const prices = Array.isArray(fuelOptions.fuelPrices)
    ? fuelOptions.fuelPrices.map(objectValue)
    : [];
  const fuelTypes = prices
    .map((price) => price.type)
    .filter((type): type is string => typeof type === "string");
  const firstPrice = prices[0] ?? {};
  const firstMoney = objectValue(firstPrice.price);
  const units =
    typeof firstMoney.units === "string"
      ? Number(firstMoney.units)
      : typeof firstMoney.units === "number"
        ? firstMoney.units
        : null;
  const nanos = typeof firstMoney.nanos === "number" ? firstMoney.nanos / 1e9 : 0;
  const price = units === null || !Number.isFinite(units) ? null : units + nanos;
  return {
    fuelTypes,
    fuelPriceType: typeof firstPrice.type === "string" ? firstPrice.type : null,
    price,
    currency:
      typeof firstMoney.currencyCode === "string"
        ? firstMoney.currencyCode
        : "INR",
    priceUpdatedAt:
      typeof firstPrice.updateTime === "string" ? firstPrice.updateTime : null,
  };
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

function textValue(value: unknown): string {
  const object = objectValue(value);
  return typeof object.text === "string" ? object.text : "";
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


function json(body: unknown, status: number, cors: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...cors,
    },
  });
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
