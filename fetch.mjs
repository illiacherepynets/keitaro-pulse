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
import { encryptData } from "./crypto.mjs";
// Розбір назви кампанії спільний із tds.mjs: гео звідти задає країну перевірки.
import { parseCampaign } from "./campaign.mjs";

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

// Відображувані назви команд. Порядок = порядок команд у KT_TEAMS.
// Тримаємо їх тут, а не в секреті: перейменувати можна одним комітом, не
// перевводячи URL та API-ключі, де одна помилка ламає всю збірку.
// Порожній рядок або відсутній елемент → лишається назва з KT_TEAMS.
const TEAM_NAMES = ["Folders", "Drop domains", "Monobrands", "Asia", "Italy"];

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

// Макроси, які реально несуть клік-айді Keitaro в посиланні офера.
// {campaign_id}, {position} тощо сюди НЕ входять — вони не дають мережі чим
// зіставити конверсію. Нерозпізнані плейсхолдери ({yourclickid} і подібні)
// теж не рахуються: Keitaro їх не підставляє, мережа отримає текст як є.
const CLICKID_MACRO = /\{(subid|sub_id|click_id|clickid|external_id|visit_id|sub_id_\d+|sub\d+)\}/i;


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

// ── HTTP із таймаутом і повтором ─────────────────────────────────────────────
// Без таймауту інстанс, який приймає з'єднання і мовчить, вішав увесь прогін
// до 6-годинного ліміту GitHub — саме так збірка «підвисала».
const REQ_TIMEOUT_MS = 90_000;
const REQ_RETRIES = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, init, label) {
  let last;
  for (let attempt = 0; attempt <= REQ_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
      // Повторюємо лише те, що має шанс минути саме собою: 5xx і 429.
      if (res.status >= 500 || res.status === 429) {
        last = new Error(`${label} → HTTP ${res.status}`);
        if (attempt < REQ_RETRIES) { await sleep(2000 * (attempt + 1)); continue; }
        throw last;
      }
      return res;
    } catch (e) {
      last = e;
      const retriable = e.name === "TimeoutError" || e.name === "AbortError" ||
        e.code === "ECONNRESET" || e.code === "ETIMEDOUT" || e.code === "ENOTFOUND" ||
        /HTTP (5\d\d|429)/.test(String(e.message));
      if (!retriable || attempt === REQ_RETRIES) throw last;
      log(`  ⟳ ${label}: ${redact(String(e.message)).slice(0, 80)} — повтор ${attempt + 1}/${REQ_RETRIES}`);
      await sleep(2000 * (attempt + 1));
    }
  }
  throw last;
}

// ── Клієнт одного Keitaro-інстансу ───────────────────────────────────────────
function makeClient(url, key) {
  const API = url.replace(/\/+$/, "") + "/admin_api/v1";
  const headers = { "Api-Key": key, "Content-Type": "application/json" };
  async function report(grouping, from, to, metrics) {
    const res = await request(API + "/report/build", {
      method: "POST", headers,
      body: JSON.stringify({
        range: { from: from + " 00:00:00", to: to + " 23:59:59", timezone: TZ },
        grouping, metrics, filters: [], sort: [], summary: false, limit: 100000, offset: 0,
      }),
    }, `report ${grouping.join("+")}`);
    if (!res.ok) throw new Error(`report ${grouping.join("+")} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return Array.isArray(j) ? j : (j.rows || []);
  }
  async function apiGet(path) {
    const res = await request(API + path, { headers }, `GET ${path}`);
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

// ── Jira: що робили сеошники ─────────────────────────────────────────────────
// Сторінка статична, MCP вона не вміє — тому збірка ходить звичайним REST API
// з токеном із секрету KT_JIRA:
//   {"site":"xxx.atlassian.net","email":"...","token":"...","project":"SEO"}
// Якщо секрету немає або Jira недоступна — решта звіту збирається як раніше,
// а вкладка показує інструкцію замість даних.
const JIRA_DAYS = 35;
const JIRA_FIELDS = ["summary","status","assignee","reporter","created",
  "statuscategorychangedate","issuetype","parent","labels"];

async function fetchJira(fmtDayTz) {
  const raw = process.env.KT_JIRA;
  if (!raw) { log("Jira: секрет KT_JIRA не заданий — вкладка покаже інструкцію"); return null; }
  let cfg; try { cfg = JSON.parse(raw); } catch { log("Jira: KT_JIRA не є JSON"); return null; }
  const site = String(cfg.site || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const project = String(cfg.project || "SEO");
  if (!site || !cfg.email || !cfg.token) { log("Jira: у KT_JIRA бракує site, email або token"); return null; }
  SECRET_HOSTS.push(site);
  const headers = {
    Authorization: "Basic " + Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64"),
    Accept: "application/json", "Content-Type": "application/json",
  };
  const jql = `project = "${project}" AND (statusCategoryChangedDate >= -${JIRA_DAYS}d OR created >= -${JIRA_DAYS}d) ORDER BY statusCategoryChangedDate DESC`;

  const rows = [];
  try {
    // Новий ендпоінт шукає з nextPageToken; на старіших інстансах його немає,
    // тому тихо відкочуємось на /search зі startAt.
    let token = null, guard = 0, legacy = false;
    do {
      let res, j;
      if (!legacy) {
        res = await request(`https://${site}/rest/api/3/search/jql`, {
          method: "POST", headers,
          body: JSON.stringify({ jql, fields: JIRA_FIELDS, maxResults: 100, ...(token ? { nextPageToken: token } : {}) }),
        }, "jira search");
        if (res.status === 404 || res.status === 410) { legacy = true; continue; }
      } else {
        res = await request(`https://${site}/rest/api/3/search`, {
          method: "POST", headers,
          body: JSON.stringify({ jql, fields: JIRA_FIELDS, maxResults: 100, startAt: rows.length }),
        }, "jira search (legacy)");
      }
      if (!res.ok) throw new Error(`jira → HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      j = await res.json();
      const batch = j.issues || [];
      rows.push(...batch);
      token = legacy ? null : (j.isLast ? null : (j.nextPageToken || null));
      if (legacy && batch.length === 100 && rows.length < (j.total || 0)) token = "more";
    } while (token && ++guard < 30);
  } catch (e) { log(`Jira: ${redact(String(e.message)).slice(0, 160)} — вкладка лишиться без даних`); return null; }

  const people = [], pSlot = new Map();
  const slotP = (n) => { const k = n || "— без виконавця —";
    if (!pSlot.has(k)) { pSlot.set(k, people.length); people.push(k); } return pSlot.get(k); };
  const dayOf = (iso) => { if (!iso) return ""; const d = new Date(iso); return isNaN(d) ? "" : fmtDayTz(d); };

  // issues: [key, назва, виконавець, день закриття, день створення,
  //          сам собі (0/1), тип, батьківська задача, мітки, постановник]
  const issues = rows.map((it) => {
    const f = it.fields || {};
    const a = f.assignee, r = f.reporter;
    const done = f.status && f.status.statusCategory && f.status.statusCategory.key === "done";
    return [
      it.key, String(f.summary || ""),
      a ? slotP(a.displayName) : -1,
      done ? dayOf(f.statuscategorychangedate) : "",
      dayOf(f.created),
      (a && r && a.accountId === r.accountId) ? 1 : 0,
      (f.issuetype && f.issuetype.name) || "",
      (f.parent && f.parent.fields && f.parent.fields.summary) || "",
      (f.labels || []).slice(0, 6),
      r ? slotP(r.displayName) : -1,
      (f.status && f.status.name) || "",
    ];
  });
  const doneN = issues.filter((x) => x[3]).length;
  log(`Jira: ${issues.length} задач за ${JIRA_DAYS} дн (закритих: ${doneN}) · людей: ${people.length}`);
  return { site, project, days: JIRA_DAYS, people, issues };
}

async function main() {
  const t0 = Date.now();
  const { teams: TEAMS, password: PASSWORD } = await loadConfig();
  TEAMS.forEach((t, i) => { if (TEAM_NAMES[i]) t.name = TEAM_NAMES[i]; });
  SECRET_HOSTS = TEAMS.map((t) => { try { return new URL(t.url).hostname; } catch { return ""; } }).filter(Boolean);
  const fmtDayTz = (d) => d.toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD у TZ
  const now = new Date();
  const yst = new Date(now); yst.setDate(yst.getDate() - 1);
  const toDay = INCLUDE_TODAY ? fmtDayTz(now) : fmtDayTz(yst);
  let searchFrom = SEARCH_FROM;
  if (DAYS_BACK) { const d = new Date(now); d.setDate(d.getDate() - DAYS_BACK); searchFrom = fmtDayTz(d); }

  // Jira не критична для звіту — беремо її першою, щоб у логах було видно,
  // чи вона взагалі відповіла, але падіння не зупиняє збірку.
  const jira = await fetchJira(fmtDayTz);

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
    if (!dayRows.length) { log("  (немає даних у діапазоні)"); raw.push({ dayRows: [], cdRaw: [], odRaw: [], relRaw: [], osRaw: [], nameById: new Map(), netsRaw: [], offersRaw: [] }); continue; }
    const tDays = [...new Set(dayRows.map((r) => r.day))].sort();
    const from = tDays[0], to = tDays[tDays.length - 1];
    log(`  історія: ${tDays.length} дн. (${from} … ${to})`);
    const chunks = monthChunks(from, to);
    const nameById = new Map();
    try { for (const c of await cl.apiGet("/campaigns")) if (c && c.id != null) nameById.set(c.id, c.name); } catch (e) {}
    // Довідники для вкладки «Партнерки». Не критичні: якщо впадуть —
    // решта звіту має зібратись як раніше.
    let netsRaw = [], offersRaw = [];
    try { netsRaw = await cl.apiGet("/affiliate_networks"); } catch (e) { log(`  ⚠ мережі недоступні (${redact(e.message)})`); }
    try { offersRaw = await cl.apiGet("/offers"); } catch (e) { log(`  ⚠ довідник оферів недоступний (${redact(e.message)})`); }
    const cdRaw = await cl.reportOverChunks(["day", "campaign"], chunks, METRICS);
    const odRaw = await cl.reportOverChunks(["day", "offer"], chunks, METRICS);
    const relRaw = await cl.reportOverChunks(["campaign", "offer", "sub_id_2", "sub_id_3"], chunks, METRICS);
    const osRaw = await cl.report(["os"], from, to, ["clicks", "conversions", "revenue"]);
    log(`  cd:${cdRaw.length} · od:${odRaw.length} · rel:${relRaw.length}`);
    raw.push({ dayRows, cdRaw, odRaw, relRaw, osRaw, nameById, netsRaw, offersRaw });
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

  // ── Партнерські мережі та офери (довідник, не трафік) ────────────────────
  // nets: [назва, команда, є postback_url, є offer_param, скільки оферів]
  // noff: [oi в offers або -1, назва (лише якщо oi<0), команда, netIdx, свій макрос]
  const nets = [], noff = [];
  raw.forEach((r, ti) => {
    if (!r) return;
    const netIdx = new Map();                       // id мережі в Keitaro → індекс у nets
    for (const n of r.netsRaw || []) {
      if (!n || n.id == null) continue;
      netIdx.set(n.id, nets.length);
      nets.push([String(n.name || "(без назви)"),
        ti,
        String(n.postback_url || "").trim() ? 1 : 0,
        String(n.offer_param || "").trim() ? 1 : 0,
        0]);
    }
    for (const o of r.offersRaw || []) {
      if (!o || !o.name) continue;
      const ni = netIdx.has(o.affiliate_network_id) ? netIdx.get(o.affiliate_network_id) : -1;
      if (ni >= 0) nets[ni][4]++;
      const oi = offSlot.has(o.name) ? offSlot.get(o.name) : -1;
      noff.push([oi, oi >= 0 ? "" : String(o.name), ti, ni,
        CLICKID_MACRO.test(String(o.action_payload || "")) ? 1 : 0]);
    }
  });
  const netsBad = nets.filter((n) => !n[2]).length;
  log(`Партнерок: ${nets.length} (без постбеку: ${netsBad}) · оферів у довіднику: ${noff.length}`);

  // ОС по кожній команді окремо
  const os = raw.map((r) => r
    ? r.osRaw.map((x) => [x.os || "—", num(x.clicks), num(x.conversions), money(x.revenue)]).sort((a, b) => b[1] - a[1])
    : []);

  const DATA = {
    generated: new Date().toLocaleString("uk-UA", { timeZone: TZ }),
    builtAt: new Date().toISOString(),   // машинна мітка: скільки даним годин
    range: { from: fromDay, to: lastDay },
    teams, days, totals, camps, cd, offers, od, os, rel, positions, pages, nets, noff, jira,
  };

  // Результати перевірки ТДС лежать окремим зашифрованим файлом: їх пише інший
  // воркфлоу і в інший час, тож збірка просто проносить блоб у сторінку як є —
  // розшифрує його браузер тим самим паролем.
  let tdsBlob = "";
  try {
    tdsBlob = (await readFile(join(__dir, "data", "tds.enc"), "utf8")).trim();
    log(`ТДС: підхопив минулу перевірку (${(tdsBlob.length / 1024).toFixed(0)} KB)`);
  } catch { log("ТДС: перевірки ще не було — вкладка покаже інструкцію"); }

  const template = await readFile(join(__dir, "template.html"), "utf8");
  const jsonStr = JSON.stringify(DATA);
  let inject;
  if (PASSWORD) {
    const { b64, iter } = await encryptData(jsonStr, PASSWORD);
    inject = `window.KT_ENC=${JSON.stringify(b64)};window.KT_KDF={iter:${iter}};`
      + (tdsBlob ? `window.KT_TDS=${JSON.stringify(tdsBlob)};` : "");
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
