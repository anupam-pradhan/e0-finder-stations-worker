import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  parseSitemapIndex, citySitemapMeta, isPriorityCity, parseCitySitemap,
  parsePriceFragment, power100Card, parseOutletPage, nameFromSlug,
  upsertPower100Station, FUEL_GRADE_POWER100,
} from '../src/hpcl.ts';

test('sitemap index + city sitemap parse to outlet ids', () => {
  const index = `<sitemapindex><sitemap><loc>https://petrolpump.hpretail.in/files/enterprise/sitemap/google/96681/delhi/new_delhi.xml.gz</loc></sitemap>
    <sitemap><loc>https://petrolpump.hpretail.in/files/enterprise/sitemap/google/96681/manipur/thoubal.xml.gz</loc></sitemap></sitemapindex>`;
  const urls = parseSitemapIndex(index);
  assert.equal(urls.length, 2);
  assert.ok(isPriorityCity(urls[0]));
  assert.ok(!isPriorityCity(urls[1]));
  assert.deepEqual(citySitemapMeta(urls[0]), {state: 'delhi', city: 'new_delhi'});
  const city = `<urlset><url><loc>https://petrolpump.hpretail.in/hindustan-petroleum-corporation-limited-central-s-s-petrol-pump-connaught-place-new-delhi-97359/Home</loc></url>
    <url><loc>https://petrolpump.hpretail.in/hindustan-petroleum-corporation-limited-central-s-s-petrol-pump-connaught-place-new-delhi-97359/Map</loc></url></urlset>`;
  const outlets = parseCitySitemap(city, 'delhi', 'new_delhi');
  assert.equal(outlets.length, 1);
  assert.equal(outlets[0].id, '97359');
  assert.match(outlets[0].slug, /connaught-place-new-delhi$/);
});

test('price fragment parse finds Power 100 with price and stock', () => {
  const html = `<div class="card"><span class="fuel_Name">Petrol</span><span class="fuel-text">102.15 ₹/L</span><div class="in-stock">In Stock</div></div>
    <div class="card"><span class="fuel_Name">Power 100</span><span class="fuel-text">168.00 ₹/L</span><div class="out-of-stock">Out of Stock</div></div>`;
  const cards = parsePriceFragment(html);
  assert.deepEqual(cards.map((c) => c.name), ['Petrol', 'Power 100']);
  const p100 = power100Card(cards);
  assert.equal(p100.price, 168);
  assert.equal(p100.inStock, false);
  assert.equal(power100Card(parsePriceFragment('<span class="fuel_Name">Petrol</span>')), undefined);
});

test('outlet page JSON-LD gives coordinates, address and phone', () => {
  const html = `<script type="application/ld+json">{"@type":"LocalBusiness","name":"Hindustan Petroleum Corporation Limited",
    "geo":{"latitude":"28.63183814","longitude":"77.22149344"},
    "address":[{"streetAddress":"Radial Road No 7","addressLocality":"Connaught Place","addressRegion":"New Delhi","postalCode":"110001","telephone":["+919818020706"]}]}</script>`;
  const info = parseOutletPage(html);
  assert.equal(info.latitude, 28.63183814);
  assert.equal(info.longitude, 77.22149344);
  assert.equal(info.address, 'Radial Road No 7, Connaught Place');
  assert.equal(info.postalCode, '110001');
  assert.equal(info.phone, '+919818020706');
  assert.equal(nameFromSlug('hindustan-petroleum-corporation-limited-central-s-s-petrol-pump-connaught-place-new-delhi', 'Connaught Place'),
    'Central SS Petrol Pump, Connaught Place'.replace('SS', 'S S'));
});

const env = {SUPABASE_URL: 'https://db.example', SUPABASE_PUBLISHABLE_KEY: 'pk', SUPABASE_SERVICE_ROLE_KEY: 'svc', STATIONS_BUCKET: {}};
const outlet = {id: '97359', slug: 'hindustan-petroleum-corporation-limited-central-s-s-petrol-pump-connaught-place-new-delhi',
  state: 'delhi', city: 'new_delhi', lastChecked: 0, power100: false, latitude: 28.6318, longitude: 77.2215, locality: 'Connaught Place'};
const card = {name: 'Power 100', price: 168, inStock: true};

test('upsert upgrades an existing nearby pump instead of duplicating it', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push({u, init});
    if (u.includes('/rpc/stations_nearby')) return new Response(JSON.stringify([{id: 'gplaces-ChIJexisting', source: 'google_crawl'}]));
    return new Response(null, {status: 204});
  };
  const id = await upsertPower100Station(env, outlet, card);
  assert.equal(id, 'gplaces-ChIJexisting');
  const patch = calls.find((c) => c.init.method === 'PATCH');
  assert.match(patch.u, /stations\?id=eq\.gplaces-ChIJexisting/);
  const body = JSON.parse(patch.init.body);
  assert.equal(body.fuel_grade, FUEL_GRADE_POWER100);
  assert.equal(body.source, 'hpcl');
  assert.equal(body.is_e0_confirmed, undefined, 'never claims E0 (Power 100 may hold up to 4.5% ethanol)');
  assert.ok(!calls.some((c) => c.init.method === 'POST' && c.u.includes('on_conflict')));
});

test('upsert inserts hpcl-<id> when no pump is nearby', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push({u, init});
    if (u.includes('/rpc/stations_nearby')) return new Response('[]');
    return new Response(null, {status: 201});
  };
  const id = await upsertPower100Station(env, outlet, card);
  assert.equal(id, 'hpcl-97359');
  const post = calls.find((c) => c.init.method === 'POST' && c.u.includes('on_conflict'));
  const body = JSON.parse(post.init.body);
  assert.equal(body.id, 'hpcl-97359');
  assert.equal(body.brand, 'HPCL');
  assert.equal(body.is_e0_confirmed, false);
  assert.equal(body.source, 'hpcl');
  assert.equal(body.price, 168);
  assert.match(body.name, /Central S S Petrol Pump/);
});

test('indexing is incremental and resumes after a throttled sitemap', async () => {
  const {indexPendingSitemaps} = await import('../src/hpcl.ts?inc=1');
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const u = String(url);
    if (u.includes('/delhi/new_delhi.xml.gz')) {
      return new Response(new Blob([new TextEncoder().encode(
        '<urlset><url><loc>https://petrolpump.hpretail.in/hindustan-petroleum-corporation-limited-x-new-delhi-97359/Home</loc></url></urlset>')]).stream().pipeThrough(new CompressionStream('gzip')));
    }
    return new Response('throttled', {status: 429});
  };
  const index = {builtAt: 1, outlets: [], pendingSitemaps: [
    'https://petrolpump.hpretail.in/files/enterprise/sitemap/google/96681/delhi/new_delhi.xml.gz',
    'https://petrolpump.hpretail.in/files/enterprise/sitemap/google/96681/maharashtra/mumbai.xml.gz']};
  const added = await indexPendingSitemaps(index, 10);
  assert.equal(added, 1);
  assert.equal(index.outlets[0].id, '97359');
  assert.deepEqual(index.pendingSitemaps, ['https://petrolpump.hpretail.in/files/enterprise/sitemap/google/96681/maharashtra/mumbai.xml.gz'], 'throttled sitemap stays pending');
});
