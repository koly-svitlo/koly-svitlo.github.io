// Fetches the outage schedule from ztoe.com.ua and merges it into data.json.
// Run: node scripts/update.mjs
import { readFile, writeFile } from "node:fs/promises";

const SRC = "https://www.ztoe.com.ua/unhooking-search.php";
const DATA = new URL("../data.json", import.meta.url);
const QUEUES = ["1.1","1.2","2.1","2.2","3.1","3.2","4.1","4.2","5.1","5.2","6.1","6.2"];

function kyivDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(d); // YYYY-MM-DD
}

async function fetchHtml() {
  const res = await fetch(SRC, { headers: { "User-Agent": "Mozilla/5.0 (svitlo-berdychiv schedule reader)" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.toString("latin1", 0, 4000);
  const cs = (head.match(/charset=["']?([\w-]+)/i) || [])[1] || "utf-8";
  return new TextDecoder(cs.toLowerCase().includes("1251") ? "windows-1251" : "utf-8").decode(buf);
}

const strip = s => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function parse(html) {
  const out = {};
  const tables = html.split(/<table\b/i).slice(1);
  for (const t of tables) {
    const text = strip(t.slice(0, 6000));
    const dm = text.match(/Підчерга[\s\S]*?(\d\d)\.(\d\d)\.(\d{4})/);
    if (!dm) continue;
    const dates = [...text.matchAll(/(\d\d)\.(\d\d)\.(\d{4})/g)]
      .map(m => `${m[3]}-${m[2]}-${m[1]}`)
      .filter((v, i, a) => a.indexOf(v) === i);
    const rows = t.split(/<tr\b/i).slice(1);
    for (const r of rows) {
      const cells = r.split(/<td\b/i).slice(1);
      const texts = cells.map(c => strip("<x " + c));
      const qi = texts.findIndex(x => /^\d\.\d$/.test(x));
      if (qi < 0) continue;
      const q = texts[qi];
      const slots = cells.slice(qi + 2).map(c => {
        const bg = ((c.match(/background:\s*([^;"]+)/i) || [])[1] || "").trim();
        return !bg || /ffffff|white/i.test(bg) ? "." : "X";
      });
      if (slots.length < 48) continue;
      for (let k = 0; k * 48 + 48 <= slots.length && k < dates.length; k++) {
        const date = dates[k];
        (out[date] ??= {})[q] = slots.slice(k * 48, k * 48 + 48).join("");
      }
    }
  }
  return out;
}

const html = await fetchHtml();
const parsed = parse(html);
const updated = (strip(html).match(/Дата оновлення інформації\s*-\s*([0-9:]+\s+[0-9.]+)/) || [])[1] || "";

const valid = Object.entries(parsed).filter(([, q]) => QUEUES.every(x => /^[.X]{48}$/.test(q[x] || "")));
if (!valid.length) {
  console.error("Could not read the schedule table. Parsed:", JSON.stringify(parsed).slice(0, 500));
  process.exit(1);
}

let data = { days: {} };
try { data = JSON.parse(await readFile(DATA, "utf8")); } catch {}
data.days ??= {};

let changed = false;
const changedDates = [];
for (const [date, q] of valid) {
  const prev = data.days[date];
  const same = prev && QUEUES.every(x => prev.q?.[x] === q[x]);
  if (!same) { data.days[date] = { updated, q }; changed = true; changedDates.push(date); }
}
const yesterday = kyivDate(-1);
for (const d of Object.keys(data.days)) if (d < yesterday) { delete data.days[d]; changed = true; }

// Record the check time when something changed, or at least every 3 hours,
// so the site can show "перевірено N хв тому" without a commit every 30 minutes.
const stale = !data.checked || Date.now() - new Date(data.checked).getTime() > 3 * 3600e3;
if (changed || stale) {
  data.checked = new Date().toISOString();
  await writeFile(DATA, JSON.stringify(data, null, 2) + "\n");
  console.log(changed ? "Updated: " + changedDates.join(", ") : "Check time refreshed.");
} else {
  console.log("No changes.");
}
