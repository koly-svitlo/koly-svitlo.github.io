// Builds addresses.json: every street of Berdychiv district (Бердичівський РЕМ)
// with its houses and outage queue, read from the address search on ztoe.com.ua.
// Run: node scripts/addresses.mjs            (whole district)
//      node scripts/addresses.mjs --city     (only the city of Berdychiv)
import { writeFile } from 'node:fs/promises';

const SRC = 'https://www.ztoe.com.ua/unhooking-search.php';
const REM_ID = '3'; // Бердичівський
const OUT = new URL('../addresses.json', import.meta.url);
const DELAY = 250;
const FETCH_TIMEOUT = Number(process.env.FETCH_TIMEOUT) || 30000;
const MAX_RETRIES = 3;
const onlyCity = process.argv.includes('--city');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function post(params, tries = MAX_RETRIES) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetchWithTimeout(SRC, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (svitlo-berdychiv address reader)',
        },
        body: new URLSearchParams(params),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const cs =
        (buf.toString('latin1', 0, 4000).match(/charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
      return new TextDecoder(/1251/.test(cs) ? 'windows-1251' : 'utf-8').decode(buf);
    } catch (e) {
      if (i >= tries) throw e;
      console.warn(`POST attempt ${i} failed: ${e.message}. Retrying in ${i * 2}s...`);
      await sleep(2000 * i);
    }
  }
}

const decode = s =>
  s
    .replace(/&#0?39;/g, "'")
    .replace(/"/g, '"')
    .replace(/&/g, '&')
    .replace(/&nbsp;/g, ' ');
const strip = s =>
  decode(s.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

function options(html, name) {
  const m = html.match(new RegExp(`<select[^>]*name=["']?${name}[\\s\\S]*?</select>`, 'i'));
  if (!m) return [];
  return [...m[0].matchAll(/<option[^>]*value=["']?(\d+)["']?[^>]*>([^<]*)/gi)]
    .map(x => ({ id: x[1], name: decode(x[2]).trim() }))
    .filter(x => x.id !== '0');
}

function results(html) {
  const start = html.indexOf('За Вашим запитом');
  if (start < 0) return [];
  const end = html.indexOf('</table>', start);
  const rows = html.slice(start, end).split(/<tr\b/i).slice(2);
  return rows
    .map(r =>
      r
        .split(/<td\b/i)
        .slice(1)
        .map(c => strip('<x ' + c))
    )
    .filter(c => c.length >= 6 && c[3])
    .map(c =>
      /^\d$/.test(c[4]) && /^\d$/.test(c[5])
        ? { houses: c[3], q: c[4] + '.' + c[5], note: c[6] || '' }
        : { houses: c[3], q: null, info: c[4], note: c[6] || '' }
    ); // e.g. "В цей час не вимикається…"
}

const rem = await post({ rem_id: REM_ID });
let places = options(rem, 'naspunkt_id');
if (onlyCity) places = places.filter(p => /Бердичів/.test(p.name));
console.log('Settlements:', places.length);

const out = [];
let streetCount = 0;
for (const p of places) {
  await sleep(DELAY);
  const streets = options(await post({ rem_id: REM_ID, naspunkt_id: p.id }), 'vulica_id');
  const place = { name: p.name, streets: [] };
  for (const s of streets) {
    await sleep(DELAY);
    const rows = results(await post({ rem_id: REM_ID, naspunkt_id: p.id, vulica_id: s.id }));
    if (rows.length) place.streets.push({ name: s.name, rows });
    streetCount++;
  }
  console.log(`${p.name}: ${place.streets.length}/${streets.length} streets`);
  if (place.streets.length) out.push(place);
}

if (!out.length) {
  console.error('No addresses read');
  process.exit(1);
}
out.sort(
  (a, b) => /^місто/.test(b.name) - /^місто/.test(a.name) || a.name.localeCompare(b.name, 'uk')
);
await writeFile(
  OUT,
  JSON.stringify({ updated: new Date().toISOString().slice(0, 10), places: out }) + '\n'
);
console.log('Done:', out.length, 'settlements,', streetCount, 'streets');
