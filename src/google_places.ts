// Live Google Places (New) "Nearby Search" for areas the Supabase catalogue
// doesn't cover yet. The API key is a Worker SECRET (never shipped in the app).
//
// Cost: the field mask below uses only Pro-tier fields (id, name, address,
// location) — adding rating/phone/hours would bump every call to Enterprise.
// Terms: Google allows storing only place IDs indefinitely, so these results
// are returned live and never written to Supabase or the edge cache.

export interface GooglePlacesEnv {
  GOOGLE_PLACES_API_KEY?: string;
}

const NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";
const FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location";
const TIMEOUT_MS = 4000;

type GooglePlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
};

export function googlePlacesConfigured(env: GooglePlacesEnv): boolean {
  return Boolean(env.GOOGLE_PLACES_API_KEY);
}

export async function googleNearbyStations(
  env: GooglePlacesEnv,
  latitude: number,
  longitude: number,
  radiusMeters: number,
  maxResults: number,
): Promise<Record<string, unknown>[]> {
  if (!env.GOOGLE_PLACES_API_KEY) return [];
  const response = await fetch(NEARBY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({
      includedTypes: ["gas_station"],
      maxResultCount: Math.min(Math.max(Math.trunc(maxResults), 1), 20),
      rankPreference: "DISTANCE",
      locationRestriction: {
        circle: {
          center: { latitude, longitude },
          radius: Math.min(Math.max(radiusMeters, 500), 50000),
        },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Places nearby failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { places?: GooglePlace[] };
  return (body.places ?? [])
    .filter(
      (place) =>
        place.id &&
        typeof place.location?.latitude === "number" &&
        typeof place.location?.longitude === "number",
    )
    .map((place) => toStation(place));
}

function toStation(place: GooglePlace): Record<string, unknown> {
  const latitude = place.location!.latitude!;
  const longitude = place.location!.longitude!;
  const name = place.displayName?.text?.trim() || "Fuel station";
  return {
    placeId: place.id,
    name,
    address: place.formattedAddress?.trim() || "Address unavailable",
    latitude,
    longitude,
    sourceUri:
      `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}` +
      `&query_place_id=${encodeURIComponent(place.id!)}`,
    primaryType: "gas_station",
    phone: null,
    isOpen: null,
    openingHours: [],
    rating: null,
    reviewCount: null,
    fuelTypes: [],
    isCoco: false,
    fuelPriceType: null,
    price: null,
    currency: "INR",
    priceUpdatedAt: null,
    photoResourceName: null,
    photoAttributions: [],
  };
}
