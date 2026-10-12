// Official HPCL poWer100 outlets from HPCL's own public outlet locator.
//
// Why this is allowed: HPCL's Terms of Use permit reproducing site material
// free of charge provided the source is acknowledged, and the locator's
// robots.txt allows outlet pages and the price fragment. We crawl politely
// (small batches, delays, identified user agent) and attribute HPCL.
//
// How it works:
//   1. The sitemap index lists one sitemap per city. We index outlets for the
//      cities where premium fuel is sold (PRIORITY_CITIES) into R2.
//   2. Every run checks a rotating batch of outlets' "Today's Fuel Price"
//      fragment; a "Power 100" card means the outlet sells it.
//   3. Such outlets are merged into Supabase: if a pump already exists within
//      60 m (e.g. a Google-crawled row) that row is upgraded, otherwise a new
//      `hpcl-<id>` row is inserted. Power 100 may contain up to 4.5% ethanol,
//      so it is recorded as a low-ethanol premium grade, never as E0.

export interface HpclEnv {
  STATIONS_BUCKET: R2Bucket;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

const BASE = "https://petrolpump.hpretail.in";
const MASTER_OUTLET_ID = "96681";
const USER_AGENT = "Mozilla/5.0 (compatible; E0FinderBot/1.0; +https://e0finder.com)";
const INDEX_KEY = "hpcl/outlets.json";
const INDEX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
// HPCL throttles bursts of ~50 requests; ~1 req/s stays well under that.
const DELAY_MS = 1000;
const BACKOFF_MS = 8000;
const MATCH_RADIUS_M = 60;

export const FUEL_GRADE_POWER100 = "poWer100 (low ethanol, up to 4.5%)";
export const BRAND_LOGO_HPCL = "/assets/oil_company_logo/Hindustan_Petroleum-Logo.wine.svg";

/** City sitemap name fragments (state/city) where premium fuel is sold. */
export const PRIORITY_CITIES = [
  "new_delhi", "delhi/", "mumbai", "thane", "navi_mumbai", "pune", "nashik",
  "bengaluru", "bangalore", "mysuru", "mysore", "mangaluru", "mangalore",
  "chennai", "coimbatore", "hyderabad", "secunderabad", "kolkata", "howrah",
  "ahmedabad", "surat", "vadodara", "rajkot", "jaipur", "udaipur", "chandigarh",
  "mohali", "panchkula", "ludhiana", "lucknow", "kanpur", "agra", "varanasi",
  "noida", "gautam_buddha_nagar", "ghaziabad", "gurgaon", "gurugram", "faridabad",
  "kochi", "ernakulam", "thiruvananthapuram", "kozhikode", "visakhapatnam",
  "vijayawada", "nagpur", "indore", "bhopal", "raipur", "ranchi", "patna",
  "bhubaneswar", "guwahati", "dehradun", "north_goa", "south_goa", "panaji",
];

export type HpclOutlet = {
  id: string;
  slug: string;
  state: string;
  city: string;
  lastChecked: number;
  power100: boolean;
  price?: number | null;
  inStock?: boolean;
  name?: string;
  latitude?: number;
  longitude?: number;
  address?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  phone?: string;
  stationId?: string;
};

export type HpclIndex = {
  builtAt: number;
  outlets: HpclOutlet[];
  /** City sitemaps still to be fetched; indexing is spread over runs so it
   *  never exceeds HPCL's request window. */
  pendingSitemaps: string[];
};

export type FuelCard = {name: string; price: number | null; inStock: boolean};

// ─── Parsers (pure, unit-tested) ─────────────────────────────────────────────

export function parseSitemapIndex(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1]);
}

export function citySitemapMeta(url: string): {state: string; city: string} | null {
  const m = /\/google\/\d+\/([^/]+)\/([^/]+)\.xml(?:\.gz)?$/.exec(url);
  return m ? {state: m[1], city: m[2]} : null;
}

export function isPriorityCity(url: string): boolean {
  const lower = url.toLowerCase();
  return PRIORITY_CITIES.some((c) => lower.includes(c));
}

/** Outlet ids + slugs from a city sitemap (only the `/Home` page per outlet). */
export function parseCitySitemap(xml: string, state: string, city: string): HpclOutlet[] {
  const outlets: HpclOutlet[] = [];
  for (const m of xml.matchAll(/<loc>\s*https:\/\/petrolpump\.hpretail\.in\/([^<]+?)-(\d+)\/Home\s*<\/loc>/g)) {
    outlets.push({id: m[2], slug: m[1], state, city, lastChecked: 0, power100: false});
  }
  return outlets;
}

/** "Today's Fuel Price" fragment → one card per fuel the outlet sells. */
export function parsePriceFragment(html: string): FuelCard[] {
  const cards: FuelCard[] = [];
  const blocks = html.split(/fuel_Name/).slice(1);
  for (const block of blocks) {
    const name = /^[^>]*>\s*([^<]+?)\s*</.exec(block)?.[1]?.trim();
    if (!name) continue;
    const priceText = /fuel-text[^>]*>\s*([^<]+?)\s*</.exec(block)?.[1] ?? "";
    const price = Number.parseFloat(priceText.replace(/[^\d.]/g, ""));
    const inStock = !/out-of-stock/.test(block);
    cards.push({name, price: Number.isFinite(price) ? price : null, inStock});
  }
  return cards;
}

export function power100Card(cards: FuelCard[]): FuelCard | undefined {
  return cards.find((c) => /power\s*100/i.test(c.name));
}

/** Name, coordinates and address from the outlet page's schema.org JSON-LD. */
export function parseOutletPage(html: string): Partial<HpclOutlet> {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, any>;
      if (!["LocalBusiness", "GasStation", "Store"].includes(it["@type"])) continue;
      const geo = it.geo ?? {};
      const addr = Array.isArray(it.address) ? it.address[0] : it.address ?? {};
      const latitude = Number(geo.latitude);
      const longitude = Number(geo.longitude);
      const phones = Array.isArray(addr.telephone) ? addr.telephone : [addr.telephone ?? it.telephone];
      return {
        name: typeof it.alternateName === "string" && it.alternateName.trim() ? it.alternateName.trim() : undefined,
        latitude: Number.isFinite(latitude) ? latitude : undefined,
        longitude: Number.isFinite(longitude) ? longitude : undefined,
        address: [addr.streetAddress, addr.addressLocality].filter(Boolean).join(", ") || undefined,
        locality: addr.addressLocality || undefined,
        region: addr.addressRegion || undefined,
        postalCode: addr.postalCode || undefined,
        phone: phones.find((p: unknown) => typeof p === "string" && p.trim()) || undefined,
      };
    }
  }
  return {};
}

/** "hindustan-petroleum-corporation-limited-central-s-s-petrol-pump-connaught-place-new-delhi" → "Central S S Petrol Pump, Connaught Place" */
export function nameFromSlug(slug: string, locality?: string): string {
  let s = slug.replace(/^hindustan-petroleum-corporation-limited-/, "");
  if (locality) {
    const loc = locality.toLowerCase().replace(/\s+/g, "-");
    const idx = s.toLowerCase().lastIndexOf("-" + loc);
    if (idx > 0) s = s.slice(0, idx);
  }
  const words = s.split("-").filter(Boolean).map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  const name = words.join(" ").trim() || "HPCL Petrol Pump";
  return locality ? `${name}, ${locality}` : name;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    headers: {"User-Agent": USER_AGENT, ...headers},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

async function fetchText(url: string, attempt = 0): Promise<string> {
  const res = await get(url);
  if (!res.ok) {
    // Sitemap/outlet fetches share HPCL's burst window; wait it out once.
    if (attempt === 0) {
      await sleep(BACKOFF_MS);
      return fetchText(url, 1);
    }
    throw new Error(`${url} → ${res.status}`);
  }
  if (url.endsWith(".gz")) {
    const stream = res.body!.pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return res.text();
}

export async function fetchPriceCards(outletId: string): Promise<FuelCard[]> {
  const url = `${BASE}/getPetrolPricesForHPCL.php?master_outlet_id=${MASTER_OUTLET_ID}&outlet_id=${outletId}`;
  const res = await get(url, {"X-Requested-With": "XMLHttpRequest", Referer: `${BASE}/`});
  if (!res.ok) throw new Error(`price ${outletId} → ${res.status}`);
  return parsePriceFragment(await res.text());
}


// ─── Index (R2) ───────────────────────────────────────────────────────────────

/** One request: the sitemap index. City sitemaps are fetched over later runs. */
export async function buildIndex(): Promise<HpclIndex> {
  const sitemaps = parseSitemapIndex(await fetchText(`${BASE}/sitemap.xml`)).filter(isPriorityCity);
  return {builtAt: Date.now(), outlets: [], pendingSitemaps: sitemaps};
}

/** Fetches up to `limit` pending city sitemaps and merges their outlets. */
export async function indexPendingSitemaps(index: HpclIndex, limit: number): Promise<number> {
  const known = new Map(index.outlets.map((o) => [o.id, o]));
  let added = 0;
  const batch = index.pendingSitemaps.slice(0, Math.max(0, limit));
  for (const url of batch) {
    const meta = citySitemapMeta(url);
    try {
      if (meta) {
        for (const outlet of parseCitySitemap(await fetchText(url), meta.state, meta.city)) {
          if (!known.has(outlet.id)) {
            known.set(outlet.id, outlet);
            index.outlets.push(outlet);
            added++;
          }
        }
      }
      index.pendingSitemaps = index.pendingSitemaps.filter((u) => u !== url);
    } catch (error) {
      console.error(`HPCL sitemap failed ${url}: ${error}`);
      // Leave it pending; retried next run after the window resets.
      break;
    }
    await sleep(DELAY_MS);
  }
  return added;
}

export async function loadIndex(env: HpclEnv, now: number, forceRebuild = false): Promise<HpclIndex> {
  const object = await env.STATIONS_BUCKET.get(INDEX_KEY);
  if (object) {
    const index = (await object.json()) as HpclIndex;
    index.pendingSitemaps ??= [];
    if (!forceRebuild && now - index.builtAt < INDEX_MAX_AGE_MS) return index;
    // Weekly refresh: queue every priority sitemap again, keep known outlets.
    const fresh = await buildIndex();
    return {builtAt: fresh.builtAt, outlets: index.outlets, pendingSitemaps: fresh.pendingSitemaps};
  }
  return buildIndex();
}

async function saveIndex(env: HpclEnv, index: HpclIndex): Promise<void> {
  await env.STATIONS_BUCKET.put(INDEX_KEY, JSON.stringify(index), {
    httpMetadata: {contentType: "application/json"},
  });
}

// ─── Supabase merge ───────────────────────────────────────────────────────────

type NearbyRow = {id: string; source?: string | null};

async function nearbyExisting(env: HpclEnv, latitude: number, longitude: number): Promise<NearbyRow[]> {
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  if (!env.SUPABASE_URL || !key) return [];
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/stations_nearby?select=id,source`, {
    method: "POST",
    headers: {apikey: key, "Content-Type": "application/json"},
    body: JSON.stringify({lat: latitude, lng: longitude, radius_m: MATCH_RADIUS_M, max_results: 3}),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as NearbyRow[];
  return Array.isArray(rows) ? rows : [];
}

/** Exact check time, so the app can truthfully say "Verified today, 8:15 AM". */
function today(): string {
  return new Date().toISOString();
}

/** Upgrades a nearby existing pump, or inserts `hpcl-<id>`. Returns the station id. */
export async function upsertPower100Station(env: HpclEnv, outlet: HpclOutlet, card: FuelCard): Promise<string | null> {
  const service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !service || outlet.latitude === undefined || outlet.longitude === undefined) return null;
  const headers = {apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json", Prefer: "return=minimal"};
  const official = {
    fuel_grade: FUEL_GRADE_POWER100,
    price: card.price ?? 0,
    verified_by: "HPCL outlet locator",
    last_verified: today(),
    source: "hpcl",
    needs_review: false,
    is_active: true,
    brand: "HPCL",
    brand_logo: BRAND_LOGO_HPCL,
  };

  const existingId = outlet.stationId ?? (await nearbyExisting(env, outlet.latitude, outlet.longitude))[0]?.id;
  if (existingId) {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/stations?id=eq.${encodeURIComponent(existingId)}`, {
      method: "PATCH", headers, body: JSON.stringify(official), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`patch ${existingId} → ${res.status} ${await res.text()}`);
    return existingId;
  }

  const id = `hpcl-${outlet.id}`;
  const row = {
    id,
    name: outlet.name ?? nameFromSlug(outlet.slug, outlet.locality),
    ...official,
    is_e0_confirmed: false,
    is_coco: false,
    address: outlet.address ?? "Address unavailable",
    area: outlet.locality ?? "",
    city: outlet.region ?? outlet.city.replace(/_/g, " "),
    state: outlet.state.replace(/_/g, " "),
    pincode: outlet.postalCode ?? "",
    latitude: outlet.latitude,
    longitude: outlet.longitude,
    density: "",
    rating: 0,
    review_count: 0,
    is_open_24_hours: false,
    timing: "",
    phone: outlet.phone ?? "",
    amenities: ["poWer100", "UPI / Card"],
  };
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/stations?on_conflict=id`, {
    method: "POST",
    headers: {...headers, Prefer: "resolution=merge-duplicates,return=minimal"},
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`insert ${id} → ${res.status} ${await res.text()}`);
  return id;
}

/** An outlet that no longer lists Power 100: mark the grade as regular again. */
async function downgradeStation(env: HpclEnv, stationId: string): Promise<void> {
  const service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !service) return;
  await fetch(`${env.SUPABASE_URL}/rest/v1/stations?id=eq.${encodeURIComponent(stationId)}&source=eq.hpcl`, {
    method: "PATCH",
    headers: {apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json", Prefer: "return=minimal"},
    body: JSON.stringify({fuel_grade: "Regular Petrol", last_verified: today()}),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch(() => undefined);
}

// ─── Crawl ────────────────────────────────────────────────────────────────────

export type CrawlStats = {
  indexed: number;
  checked: number;
  power100Found: number;
  upserted: number;
  errors: number;
  pendingSitemaps: number;
};

/** Checks the least-recently-checked `limit` outlets and merges results. */
export async function crawlBatch(
  env: HpclEnv,
  limit: number,
  now = Date.now(),
  onlyIds?: string[],
  forceRebuild = false,
): Promise<CrawlStats> {
  const index = await loadIndex(env, now, forceRebuild);
  const stats: CrawlStats = {indexed: index.outlets.length, checked: 0, power100Found: 0, upserted: 0, errors: 0, pendingSitemaps: 0};
  // Finish indexing first: each run spends its request budget on sitemaps
  // until every priority city is in, then on outlet price checks.
  if (index.pendingSitemaps.length > 0 && !onlyIds) {
    await indexPendingSitemaps(index, limit);
    stats.indexed = index.outlets.length;
    stats.pendingSitemaps = index.pendingSitemaps.length;
    await saveIndex(env, index);
    return stats;
  }
  stats.pendingSitemaps = index.pendingSitemaps.length;
  const batch = onlyIds
    ? index.outlets.filter((o) => onlyIds.includes(o.id))
    : [...index.outlets].sort((a, b) => a.lastChecked - b.lastChecked).slice(0, Math.max(0, limit));

  for (const outlet of batch) {
    try {
      const cards = await fetchPriceCards(outlet.id);
      const card = power100Card(cards);
      stats.checked++;
      if (card) {
        stats.power100Found++;
        if (outlet.latitude === undefined || outlet.longitude === undefined) {
          Object.assign(outlet, parseOutletPage(await fetchText(`${BASE}/${outlet.slug}-${outlet.id}/Home`)));
          await sleep(DELAY_MS);
        }
        const stationId = await upsertPower100Station(env, outlet, card);
        if (stationId) {
          outlet.stationId = stationId;
          stats.upserted++;
        }
        outlet.power100 = true;
        outlet.price = card.price;
        outlet.inStock = card.inStock;
      } else if (outlet.power100 && outlet.stationId) {
        await downgradeStation(env, outlet.stationId);
        outlet.power100 = false;
      }
    } catch (error) {
      stats.errors++;
      console.error(`HPCL outlet ${outlet.id}: ${error}`);
      // Throttled or flaky upstream: back off, and leave lastChecked so the
      // outlet is retried first next run.
      await sleep(BACKOFF_MS);
      continue;
    }
    outlet.lastChecked = now;
    await sleep(DELAY_MS);
  }

  await saveIndex(env, index);
  return stats;
}
