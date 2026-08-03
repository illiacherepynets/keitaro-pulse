// ============================================================================
//  Keitaro → локальний дашборд   (fetch.mjs)  ·  мультикомандна версія
//  ---------------------------------------------------------------------------
//  Тягне історію з КІЛЬКОХ Keitaro-інстансів (команд), тегає кожен рядок
//  командою і генерує самодостатній dashboard.html. У дашборді є фільтр
//  «Команда» → спільний звіт по всіх або по кожній окремо.
//
//  ЗАПУСК ("Старт"):   node fetch.mjs      (Node 18+, без npm-залежностей)
// ============================================================================

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { webcrypto as wc } from "node:crypto";

// ── КОНФІГ (НЕ секретне) ─────────────────────────────────────────────────────
const TZ          = "Europe/Kyiv";  // має збігатись з таймзоною звіту в Keitaro
const DAYS_BACK   = null;           // null = вся історія; або число днів (напр. 90)
const SEARCH_FROM = "2025-01-01";   // найраніша дата пошуку історії
const INCLUDE_TODAY = false;        // false = лише завершені дні (як пресети Keitaro)
//
// ── СЕКРЕТНЕ (ключі команд + пароль) НЕ зберігаємо в цьому файлі! ─────────────
//   • Онлайн (GitHub Actions): env KT_TEAMS (JSON) + KT_PASSWORD.
//   • Локально: файл teams.local.json поруч (у .gitignore), напр.:
//       { "teams": [ { "name":"Команда 1", "url":"http://IP", "key":"..." } ] }
//   Якщо пароль заданий → dashboard шифрується (для публічного хостингу).
//   Якщо ні → дані вшиваються напряму (локальний подвійний клік).
// ────────────────────────────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));

async function loadConfig() {
  if (process.env.KT_TEAMS) {
    const j = JSON.parse(process.env.KT_TEAMS);
    return { teams: Array.isArray(j) ? j : j.teams, password: process.env.KT_PASSWORD || "" };
  }
  try {
    const j = JSON.parse(await readFile(join(__dir, "teams.local.json"), "utf8"));
    const teams = Array.isArray(j) ? j : j.teams;
    return { teams, password: process.env.KT_PASSWORD || (Array.isArray(j) ? "" : j.password) || "" };
  } catch (e) {
    throw new Error("Немає конфігу команд: задай env KT_TEAMS або створи teams.local.json (див. README).");
  }
}

// AES-GCM + PBKDF2 → base64(salt|iv|ciphertext). Розшифровується в браузері.
async function encryptData(jsonStr, password) {
  const encText = new TextEncoder();
  const salt = wc.getRandomValues(new Uint8Array(16));
  const iv   = wc.getRandomValues(new Uint8Array(12));
  const iter = 200000;
  const keyMat = await wc.subtle.importKey("raw", encText.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await wc.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    keyMat, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = new Uint8Array(await wc.subtle.encrypt({ name: "AES-GCM", iv }, key, encText.encode(jsonStr)));
  const out = new Uint8Array(salt.length + iv.length + ct.length);
  out.set(salt, 0); out.set(iv, salt.length); out.set(ct, salt.length + iv.length);
  return { b64: Buffer.from(out).toString("base64"), iter };
}
const log = (...a) => console.log("•", ...a);
// У CI логи публічні → ховаємо адреси/хости з будь-якого тексту (напр. повідомлень помилок)
let SECRET_HOSTS = [];
const redact = (s) => {
  if (!process.env.CI) return String(s);
  let out = String(s).replace(/https?:\/\/[^\s/)"']+/gi, "http://***").replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "***");
  for (const h of SECRET_HOSTS) if (h) out = out.split(h).join("***");
  return out;
};
const num = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const money = (v) => Math.round(num(v) * 100) / 100;

// Спільні метрики (порядок фіксований — під нього завʼязаний дашборд)
const METRICS = ["clicks", "conversions", "leads", "sales", "revenue", "sale_revenue"];

// ── Розбір назви кампанії: префікс (мережа) / гео ────────────────────────────
const GEOS = new Set(("IT NL DE FR BE UK GB PL FI HU MY DK ES PT SE NO AT CH IE CA AU US " +
  "JP IN BR MX CL CO AR RU UA TR GR RO CZ SK BG HR SI LT LV EE NZ ZA SG TH VN PH ID KR " +
  "SA AE QA KW IL EG MA NG KE DZ TN LK BD PK").split(" "));
function parseCampaign(name) {
  const tokens = String(name).split(/[\s_]+/).filter(Boolean);
  let geo = "";
  for (const t of tokens) { if (/^[A-Z]{2}$/.test(t) && GEOS.has(t)) { geo = t === "GB" ? "UK" : t; break; } }
  const prefix = tokens[0] && /^[A-Z0-9]{2,}$/.test(tokens[0]) ? tokens[0] : "—";
  return { prefix, geo: geo || "—" };
}

function monthChunks(fromDay, toDay) {
  const chunks = [];
  let [y, m] = fromDay.split("-").map(Number);
  const [ty, tm] = toDay.split("-").map(Number);
  const pad = (n) => String(n).padStart(2, "0");
  const lastDay = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  while (y < ty || (y === ty && m <= tm)) {
    const from = `${y}-${pad(m)}-01`;
    const to = `${y}-${pad(m)}-${pad(lastDay(y, m))}`;
    chunks.push([from > fromDay ? from : fromDay, to < toDay ? to : toDay]);
    m++; if (m > 12) { m = 1; y++; }
  }
  return chunks;
}

// ── Клієнт одного Keitaro-інстансу ───────────────────────────────────────────
function makeClient(url, key) {
  const API = url.replace(/\/+$/, "") + "/admin_api/v1";
  const headers = { "Api-Key": key, "Content-Type": "application/json" };
  async function report(grouping, from, to, metrics) {
    const res = await fetch(API + "/report/build", {
      method: "POST", headers,
      body: JSON.stringify({
        range: { from: from + " 00:00:00", to: to + " 23:59:59", timezone: TZ },
        grouping, metrics, filters: [], sort: [], summary: false, limit: 100000, offset: 0,
      }),
    });
    if (!res.ok) throw new Error(`report ${grouping.join("+")} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return Array.isArray(j) ? j : (j.rows || []);
  }
  async function apiGet(path) {
    const res = await fetch(API + path, { headers });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    const j = await res.json();
    return Array.isArray(j) ? j : (j.rows || []);
  }
  async function reportOverChunks(grouping, chunks, metrics) {
    let all = [];
    for (const [f, t] of chunks) all = all.concat(await report(grouping, f, t, metrics));
    return all;
  }
  return { report, apiGet, reportOverChunks };
}

async function main() {
  const t0 = Date.now();
  const { teams: TEAMS, password: PASSWORD } = await loadConfig();
  SECRET_HOSTS = TEAMS.map((t) => { try { return new URL(t.url).hostname; } catch { return ""; } }).filter(Boolean);
  const fmtDayTz = (d) => d.toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD у TZ
  const now = new Date();
  const yst = new Date(now); yst.setDate(yst.getDate() - 1);
  const toDay = INCLUDE_TODAY ? fmtDayTz(now) : fmtDayTz(yst);
  let searchFrom = SEARCH_FROM;
  if (DAYS_BACK) { const d = new Date(now); d.setDate(d.getDate() - DAYS_BACK); searchFrom = fmtDayTz(d); }

  // ── 1) Тягнемо сирі дані по кожній команді ─────────────────────────────────
  const raw = [];
  for (let ti = 0; ti < TEAMS.length; ti++) {
    const T = TEAMS[ti];
    // У CI (публічні логи) НЕ друкуємо адресу сервера — лише назву команди.
    log(process.env.CI ? `[${T.name}]` : `[${T.name}] ${T.url}`);
    const cl = makeClient(T.url, T.key);
    let dayRows;
    try { dayRows = await cl.report(["day"], searchFrom, toDay, [...METRICS, "cost"]); }
    catch (e) { log(`  ✖ пропускаю команду (${redact(e.message)})`); raw.push(null); continue; }
    if (!dayRows.length) { log("  (немає даних у діапазоні)"); raw.push({ dayRows: [], cdRaw: [], odRaw: [], relRaw: [], osRaw: [], nameById: new Map() }); continue; }
    const tDays = [...new Set(dayRows.map((r) => r.day))].sort();
    const from = tDays[0], to = tDays[tDays.length - 1];
    log(`  історія: ${tDays.length} дн. (${from} … ${to})`);
    const chunks = monthChunks(from, to);
    const nameById = new Map();
    try { for (const c of await cl.apiGet("/campaigns")) if (c && c.id != null) nameById.set(c.id, c.name); } catch (e) {}
    const cdRaw = await cl.reportOverChunks(["day", "campaign"], chunks, METRICS);
    const odRaw = await cl.reportOverChunks(["day", "offer"], chunks, METRICS);
    const relRaw = await cl.reportOverChunks(["campaign", "offer", "sub_id_2", "sub_id_3"], chunks, METRICS);
    const osRaw = await cl.report(["os"], from, to, ["clicks", "conversions", "revenue"]);
    log(`  cd:${cdRaw.length} · od:${odRaw.length} · rel:${relRaw.length}`);
    raw.push({ dayRows, cdRaw, odRaw, relRaw, osRaw, nameById });
  }

  // ── 2) Обʼєднуємо: спільний список днів ────────────────────────────────────
  const daysSet = new Set();
  raw.forEach((r) => { if (r) r.dayRows.forEach((x) => daysSet.add(x.day)); });
  const days = [...daysSet].sort();
  if (!days.length) throw new Error("Жодна команда не повернула даних");
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const fromDay = days[0], lastDay = days[days.length - 1];

  const teams = TEAMS.map((t) => t.name);
  const totals = teams.map(() => days.map(() => [0, 0, 0, 0, 0, 0])); // [team][day] = clicks,conv,leads,sales,rev,saleRev

  const campSlot = new Map(), camps = [];   // camps: [id, name, prefix, geo, teamIdx]
  const offSlot = new Map(), offers = [];   // офери — глобально по назві (мерджаться між командами)
  const posSlot = new Map(), positions = [];
  const pageSlot = new Map(), pages = [];
  const slot = (m, arr, v) => { if (!m.has(v)) { m.set(v, arr.length); arr.push(v); } return m.get(v); };
  const cd = [], od = [], relAgg = new Map();

  function campIndex(ti, x, nameById) {
    const ckey = ti + "|" + (x.campaign_id ?? x.campaign);
    let ci = campSlot.get(ckey);
    if (ci === undefined) {
      const name = x.campaign || nameById.get(x.campaign_id) || ("Кампанія #" + (x.campaign_id ?? "?"));
      const p = parseCampaign(name);
      ci = camps.length; campSlot.set(ckey, ci); camps.push([x.campaign_id ?? null, name, p.prefix, p.geo, ti]);
    }
    return ci;
  }

  raw.forEach((r, ti) => {
    if (!r) return;
    for (const x of r.dayRows) {
      const di = dayIdx.get(x.day); if (di == null) continue;
      totals[ti][di] = [num(x.clicks), num(x.conversions), num(x.leads), num(x.sales), money(x.revenue), money(x.sale_revenue)];
    }
    for (const x of r.cdRaw) {
      const di = dayIdx.get(x.day); if (di == null) continue;
      const ci = campIndex(ti, x, r.nameById);
      cd.push([di, ci, num(x.clicks), num(x.conversions), num(x.leads), num(x.sales), money(x.revenue), money(x.sale_revenue)]);
    }
    for (const x of r.odRaw) {
      const di = dayIdx.get(x.day); if (di == null) continue;
      const oi = slot(offSlot, offers, x.offer || "(без офера)");
      od.push([di, oi, num(x.clicks), num(x.conversions), num(x.leads), num(x.sales), money(x.revenue), money(x.sale_revenue), ti]);
    }
    for (const x of r.relRaw) {
      const ci = campIndex(ti, x, r.nameById);
      const oi = slot(offSlot, offers, x.offer || "(без офера)");
      const pi = slot(posSlot, positions, x.sub_id_2 == null ? "" : String(x.sub_id_2));
      const gi = slot(pageSlot, pages, x.sub_id_3 == null ? "" : String(x.sub_id_3));
      const key = ci + "|" + oi + "|" + pi + "|" + gi;
      let a = relAgg.get(key);
      if (!a) { a = [ci, oi, pi, gi, 0, 0, 0, 0, 0, 0]; relAgg.set(key, a); }
      a[4] += num(x.clicks); a[5] += num(x.conversions); a[6] += num(x.leads); a[7] += num(x.sales); a[8] += money(x.revenue); a[9] += money(x.sale_revenue);
    }
  });
  const rel = [...relAgg.values()].map((a) => [a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], Math.round(a[8] * 100) / 100, Math.round(a[9] * 100) / 100]);

  // ОС по кожній команді окремо
  const os = raw.map((r) => r
    ? r.osRaw.map((x) => [x.os || "—", num(x.clicks), num(x.conversions), money(x.revenue)]).sort((a, b) => b[1] - a[1])
    : []);

  const DATA = {
    generated: new Date().toLocaleString("uk-UA", { timeZone: TZ }),
    range: { from: fromDay, to: lastDay },
    teams, days, totals, camps, cd, offers, od, os, rel, positions, pages,
  };

  const template = await readFile(join(__dir, "template.html"), "utf8");
  const jsonStr = JSON.stringify(DATA);
  let inject;
  if (PASSWORD) {
    const { b64, iter } = await encryptData(jsonStr, PASSWORD);
    inject = `window.KT_ENC=${JSON.stringify(b64)};window.KT_KDF={iter:${iter}};`;
    log(`🔒 дані зашифровано паролем (${(b64.length / 1024 / 1024).toFixed(2)} MB base64)`);
  } else {
    inject = "window.KT_DATA = " + jsonStr + ";";
    log("⚠ без пароля — дані вшито у відкритому вигляді (лише для локального перегляду)");
  }
  // функція-заміна, щоб $-послідовності в даних не інтерпретувались як спецсимволи
  const html = template.replace("/*__KT_DATA__*/", () => inject);

  const outArg = process.env.KT_OUT || "dashboard.html";
  const outPath = isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html, "utf8");

  const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
  log(`Команд: ${teams.length} · кампаній: ${camps.length} · брендів: ${offers.length} · днів: ${days.length}`);
  log(`Готово за ${((Date.now() - t0) / 1000).toFixed(1)}s → ${outPath} (${mb} MB)`);
}

main().catch((e) => { console.error("✖", redact(e.message)); process.exit(1); });
