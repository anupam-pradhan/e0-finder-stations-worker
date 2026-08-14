export interface Env {
  GOOGLE_PLACES_API_KEY?: string;
  ALLOWED_ORIGIN?: string;
}

type UnknownMap = Record<string, unknown>;

const richPlaceFields = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.googleMapsUri",
  "places.primaryType",
  "places.nationalPhoneNumber",
  "places.currentOpeningHours",
  "places.regularOpeningHours",
  "places.rating",
  "places.userRatingCount",
  "places.fuelOptions",
  "places.photos",
].join(",");

const basePlaceFields = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
].join(",");

const richDetailFields = richPlaceFields.replaceAll("places.", "");
const baseDetailFields = basePlaceFields.replaceAll("places.", "");
const placeIdPattern = /^[A-Za-z0-9_-]{10,256}$/;

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
          : "Google station data is temporarily unavailable.";
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
  if (osmId) return overpassStationDetails(osmId);
  validPlaceId(rawPlaceId);
  return {station: null};
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
  const body = bodyText ? objectValue(JSON.parse(bodyText)) : {};
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
    googleMapsUri: `https://www.openstreetmap.org/${type}/${id}`,
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

async function placesRequest(
  path: string,
  init: RequestInit,
  env: Env,
  fieldMask?: string,
  fallbackFieldMask?: string,
): Promise<UnknownMap> {
  const firstResult = await placesFetch(path, init, env, fieldMask);
  if (firstResult.ok) return firstResult.body;

  if (
    fallbackFieldMask &&
    fieldMask !== fallbackFieldMask &&
    firstResult.status === 403 &&
    isPermissionDenied(firstResult.googleError)
  ) {
    console.warn("Places rich fields denied; retrying with base fields", firstResult.googleError);
    const fallbackResult = await placesFetch(path, init, env, fallbackFieldMask);
    if (fallbackResult.ok) return fallbackResult.body;
    throwPlacesError(fallbackResult.status, fallbackResult.googleError, "base");
  }

  throwPlacesError(firstResult.status, firstResult.googleError, "rich");
}

async function placesFetch(
  path: string,
  init: RequestInit,
  env: Env,
  fieldMask?: string,
): Promise<{ok: true; body: UnknownMap} | {ok: false; status: number; googleError: UnknownMap}> {
  const apiKey = env.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) {
    return {ok: false, status: 503, googleError: {status: "MISSING_API_KEY"}};
  }
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("X-Goog-Api-Key", apiKey);
  if (fieldMask) headers.set("X-Goog-FieldMask", fieldMask);

  const maxAttempts = 3;
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch("https://places.googleapis.com/v1/" + path, {
      ...init,
      headers,
    });
    if (response.ok) return {ok: true, body: objectValue(await response.json())};
    lastStatus = response.status;
    lastBody = await response.text();
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxAttempts) break;
    await sleep(200 * Math.pow(2, attempt - 1));
  }
  const googleError = parseGoogleError(lastBody);
  console.error("Places request failed", lastStatus, googleError);
  return {ok: false, status: lastStatus, googleError};
}

function throwPlacesError(
  status: number,
  googleError: UnknownMap,
  requestMode: "rich" | "base",
): never {
  throw new PublicError(
    status === 429 ? 429 : 503,
    placesErrorMessage(status),
    {googleStatus: status, googleError, requestMode},
  );
}

function isPermissionDenied(error: UnknownMap): boolean {
  return error.status === "PERMISSION_DENIED";
}

function sanitizeStations(value: unknown): UnknownMap[] {
  return (Array.isArray(value) ? value : [])
    .map(sanitizePlace)
    .filter((station): station is UnknownMap => station !== null);
}

function sanitizePlace(value: unknown): UnknownMap | null {
  const place = objectValue(value);
  const id = typeof place.id === "string" ? place.id : "";
  const location = objectValue(place.location);
  const latitude =
    typeof location.latitude === "number" ? location.latitude : null;
  const longitude =
    typeof location.longitude === "number" ? location.longitude : null;
  if (!id || latitude === null || longitude === null) return null;

  const hours = objectValue(
    place.currentOpeningHours ?? place.regularOpeningHours,
  );
  const descriptions = Array.isArray(hours.weekdayDescriptions)
    ? hours.weekdayDescriptions.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const photos = Array.isArray(place.photos) ? place.photos : [];
  const photo = objectValue(photos[0]);
  const attributions = Array.isArray(photo.authorAttributions)
    ? photo.authorAttributions.map((item) => {
        const attribution = objectValue(item);
        return {
          displayName:
            typeof attribution.displayName === "string"
              ? attribution.displayName
              : "Google Maps contributor",
          uri: typeof attribution.uri === "string" ? attribution.uri : "",
          photoUri:
            typeof attribution.photoUri === "string"
              ? attribution.photoUri
              : null,
        };
      })
    : [];
  const fuelPrice = parseFuelOptions(place.fuelOptions);

  return {
    placeId: id,
    name: textValue(place.displayName) || "Fuel station",
    address:
      typeof place.formattedAddress === "string"
        ? place.formattedAddress
        : "Address unavailable",
    latitude,
    longitude,
    googleMapsUri:
      typeof place.googleMapsUri === "string" ? place.googleMapsUri : "",
    primaryType:
      typeof place.primaryType === "string" ? place.primaryType : "gas_station",
    phone:
      typeof place.nationalPhoneNumber === "string"
        ? place.nationalPhoneNumber
        : null,
    isOpen: typeof hours.openNow === "boolean" ? hours.openNow : null,
    openingHours: descriptions,
    rating: typeof place.rating === "number" ? place.rating : null,
    reviewCount:
      typeof place.userRatingCount === "number"
        ? place.userRatingCount
        : null,
    fuelTypes: fuelPrice.fuelTypes,
    fuelPriceType: fuelPrice.fuelPriceType,
    price: fuelPrice.price,
    currency: fuelPrice.currency,
    priceUpdatedAt: fuelPrice.priceUpdatedAt,
    photoResourceName: typeof photo.name === "string" ? photo.name : null,
    photoAttributions: attributions,
  };
}

function parseGoogleError(body: string): UnknownMap {
  try {
    const parsed = objectValue(JSON.parse(body));
    const error = objectValue(parsed.error);
    const message = typeof error.message === "string" ? error.message.slice(0, 500) : "";
    const details = Array.isArray(error.details)
      ? error.details.map((item) => sanitizeGoogleErrorDetail(item))
      : [];
    return {
      code: typeof error.code === "number" ? error.code : null,
      status: typeof error.status === "string" ? error.status : null,
      message: message || null,
      details,
    };
  } catch {
    return {message: body.slice(0, 500) || null};
  }
}

function sanitizeGoogleErrorDetail(value: unknown): UnknownMap {
  const detail = objectValue(value);
  const metadata = objectValue(detail.metadata);
  return {
    type: typeof detail["@type"] === "string" ? detail["@type"] : null,
    reason: typeof detail.reason === "string" ? detail.reason : null,
    domain: typeof detail.domain === "string" ? detail.domain : null,
    service: typeof metadata.service === "string" ? metadata.service : null,
    consumer: typeof metadata.consumer === "string" ? metadata.consumer : null,
  };
}

function placesErrorMessage(status: number): string {
  if (status === 400) {
    return "Google Places rejected the station request. Check Places API setup.";
  }
  if (status === 403) {
    return "Google Places access is blocked. Check API key restrictions, billing, and Places API (New).";
  }
  if (status === 429) {
    return "Google Places quota is exhausted. Check quota and billing.";
  }
  return "Google station data is temporarily unavailable. Places status: " + status + ".";
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

function validPlaceId(value: unknown): string {
  if (typeof value !== "string" || !placeIdPattern.test(value)) {
    throw new PublicError(400, "Invalid Google Place ID.");
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
