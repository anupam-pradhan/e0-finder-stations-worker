import assert from 'node:assert/strict';
import {test, beforeEach, afterEach} from 'node:test';

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
const originalTimer = globalThis.setTimeout;
let worker, cache, writes, pending, iteration = 0;
beforeEach(async () => {
  worker = (await import('../src/index.ts?test=' + (++iteration))).default;
  cache = new Map();
  writes = [];
  pending = [];
  globalThis.caches = {default: {
    async match(request) { return cache.get(request.url)?.clone(); },
    async put(request, response) {
      writes.push(request.url);
      cache.set(request.url, response.clone());
    },
  }};
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.caches = originalCaches;
  globalThis.setTimeout = originalTimer;
});
function request(path, body, origin = 'https://worker.example') {
  return worker.fetch(new Request(origin + '/' + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: {'Content-Type': 'application/json'},
  }), {ALLOWED_ORIGIN: '*'}, {waitUntil(promise) { pending.push(promise); }});
}
const near = {latitude: 22, longitude: 88, radiusMeters: 1000, maxResults: 20};
function osm(id = 1, type = 'node') {
  return {type, id, lat: 22, lon: 88, center: {lat: 22, lon: 88},
    tags: {amenity: 'fuel', name: 'Pump'}};
}
function photon(id, lon = 88, lat = 22, props = {}) {
  return {geometry: {coordinates: [lon, lat]},
    properties: {osm_id: id, osm_type: 'N', osm_key: 'amenity', osm_value: 'fuel', name: 'Pump', ...props}};
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

test('invalid search input returns JSON 400 instead of rejecting fetch', async () => {
  globalThis.fetch = () => { throw Error('must not call upstream'); };
  const response = await request('searchStations', {...near, maxResults: 300});
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /result count/);
});

test('Overpass requests coordinates and hot queries skip upstream', async () => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.match(init.body.get('data'), /out body center/);
    assert.doesNotMatch(init.body.get('data'), /out tags/);
    return json({elements: [osm()]});
  };
  const first = await request('searchStations', near);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).stations[0].latitude, 22);
  const second = await request('searchStations', near);
  assert.equal(second.headers.get('X-E0-Cache'), 'HIT-MEM');
  assert.equal(calls, 1);
  assert.ok(writes[0].startsWith('https://worker.example/__cache/v3/'));
});

test('different radii, limits, and nearby coordinates have distinct cache keys', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({elements: [osm()]}); };
  await request('searchStations', {...near, latitude: 22.0001});
  await request('searchStations', {...near, latitude: 22.0002});
  await request('searchStations', {...near, radiusMeters: 1100});
  await request('searchStations', {...near, maxResults: 21});
  assert.equal(calls, 4);
});

test('concurrent identical queries share upstream work', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async () => { calls++; await gate; return json({elements: [osm()]}); };
  const a = request('searchStations', near);
  const b = request('searchStations', near);
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.equal((await a).status, 200);
  assert.equal((await b).status, 200);
  assert.equal(calls, 1);
});

test('upstream failures return 503 and are not cached as empty stations', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({}, 503); };
  assert.equal((await request('searchStations', near)).status, 503);
  assert.equal((await request('searchStations', near)).status, 503);
  assert.equal(calls, 6);
  assert.equal(writes.length, 0);
});

test('partial Overpass timeout responses are retried', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? json({remark: 'runtime error: timeout', elements: [osm(1)]})
      : json({elements: [osm(2)]});
  };
  const result = await (await request('searchStations', near)).json();
  assert.equal(result.stations[0].placeId, 'osm:node:2');
  assert.equal(calls, 2);
});

test('Photon filters fuel stations and respects the requested radius', async () => {
  globalThis.fetch = async (url) => {
    if (!String(url).includes('photon')) return json({}, 503);
    assert.equal(new URL(url).searchParams.get('osm_tag'), 'amenity:fuel');
    return json({features: [photon(1), photon(2, 90), photon(3, 88, 22, {osm_value: 'restaurant'})]});
  };
  const {stations} = await (await request('searchStations', near)).json();
  assert.equal(stations.length, 1);
  assert.equal(stations[0].isOpen, null);
  assert.deepEqual(stations[0].fuelTypes, []);
});

test('Photon viewport fallback excludes pumps outside bounds', async () => {
  globalThis.fetch = async url => String(url).includes('photon')
    ? json({features: [photon(1), photon(2, 88.1)]}) : json({}, 503);
  const {stations} = await (await request('searchStationsBounds', {
    south: 21.99, west: 87.99, north: 22.01, east: 88.01, maxResults: 150,
  })).json();
  assert.equal(stations.length, 1);
});

test('text search uses Photon first and retains zero coordinates', async () => {
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    assert.ok(String(url).includes('photon'));
    assert.equal(new URL(url).searchParams.get('lat'), '0');
    assert.equal(new URL(url).searchParams.get('lon'), '0');
    return json({features: [photon(1, 0, 0)]});
  };
  const response = await request('searchStationsText', {query: 'Shell', latitude: 0, longitude: 0});
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});

test('way details use Overpass centers without a wasted element API call', async () => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.ok(String(url).includes('overpass'));
    assert.match(init.body.get('data'), /way\(2\);out body center/);
    const element = osm(2, 'way');
    delete element.lat; delete element.lon;
    return json({elements: [element]});
  };
  const {station} = await (await request('getStationDetails', {placeId: 'osm:way:2'})).json();
  assert.equal(station.latitude, 22);
  assert.equal(calls, 1);
});

test('edge cache writes do not delay the response', async () => {
  globalThis.fetch = async () => json({elements: [osm()]});
  globalThis.caches.default.put = () => new Promise(() => {});
  let timer;
  try {
    const response = await Promise.race([
      request('searchStations', near),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('blocked on cache write')), 200); }),
    ]);
    assert.equal(response.status, 200);
    assert.equal(pending.length, 1);
  } finally { clearTimeout(timer); }
});

test('all upstream attempts have bounded abort timers', async () => {
  const budgets = [];
  globalThis.setTimeout = (callback, ms, ...args) => {
    budgets.push(ms);
    return originalTimer(callback, 1, ...args);
  };
  globalThis.fetch = (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Error('aborted')), {once: true});
  });
  assert.equal((await request('searchStations', near)).status, 503);
  assert.deepEqual(budgets, [3000, 3000, 2000]);
});

const supabaseEnv = {
  ALLOWED_ORIGIN: '*',
  SUPABASE_URL: 'https://db.example',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
};
function supabaseRequest(path, body) {
  return worker.fetch(new Request('https://worker.example/' + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: {'Content-Type': 'application/json'},
  }), supabaseEnv, {waitUntil(promise) { pending.push(promise); }});
}
function row(id, latitude, longitude, extra = {}) {
  return {id, name: 'Pump ' + id, brand: 'IndianOil', address: null, area: 'Park Street',
    city: 'Kolkata', state: 'West Bengal', latitude, longitude, rating: '4.2',
    review_count: 10, timing: 'Open 24 Hours', phone: null, ...extra};
}

test('Supabase stations are served nearest first without calling Overpass', async () => {
  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(init.headers.apikey, 'sb_publishable_test');
    return json([
      row('gplaces-ChIJfarStation01', 22.05, 88.05),
      row('gplaces-ChIJnearStation1', 22.001, 88.001),
      row('gplaces-ChIJoutsideRadius', 22.5, 88.5),
    ]);
  };
  const response = await supabaseRequest('searchStations', {...near, radiusMeters: 10000});
  const {stations} = await response.json();
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/db\.example\/rest\/v1\/stations\?/);
  assert.match(urls[0], /is_active=eq\.true/);
  assert.deepEqual(stations.map((s) => s.placeId), ['ChIJnearStation1', 'ChIJfarStation01']);
  assert.equal(stations[0].rating, 4.2);
  assert.equal(stations[0].address, 'Park Street, Kolkata, West Bengal');
  assert.deepEqual(stations[0].openingHours, ['Open 24 Hours']);
  assert.match(stations[0].sourceUri, /query_place_id=ChIJnearStation1/);
});

test('Supabase failures fall back to OpenStreetMap', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://db.example')) return json({message: 'down'}, 500);
    return json({elements: [osm(7)]});
  };
  const {stations} = await (await supabaseRequest('searchStations', near)).json();
  assert.deepEqual(stations.map((s) => s.placeId), ['osm:node:7']);
});

test('station details resolve bare Google place IDs from Supabase', async () => {
  globalThis.fetch = async (url) => {
    assert.match(decodeURIComponent(String(url)), /id=in\.\("ChIJdetail000001","gplaces-ChIJdetail000001"\)/);
    return json([row('gplaces-ChIJdetail000001', 22, 88)]);
  };
  const {station} = await (await supabaseRequest('getStationDetails', {placeId: 'ChIJdetail000001'})).json();
  assert.equal(station.placeId, 'ChIJdetail000001');
});

test('text search strips PostgREST filter syntax from the query', async () => {
  globalThis.fetch = async (url) => {
    const decoded = decodeURIComponent(String(url));
    assert.match(decoded, /name\.ilike\.\*indian oil\*/);
    assert.doesNotMatch(decoded, /\(\)\)|,id\./);
    return json([row('gplaces-ChIJtextStation1', 22, 88)]);
  };
  const {stations} = await (await supabaseRequest('searchStationsText', {query: 'indian,oil)'})).json();
  assert.equal(stations.length, 1);
});
