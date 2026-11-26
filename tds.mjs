#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Перевірка ТДС-лінків з локальної для кожного лінка країни.
//
// Навіщо: ТДС віддає різне залежно від гео, девайса й мережі. Перевірити
// «чи доходить юзер до фінальної сторінки» можна лише з резидентської IP тієї
// самої країни — звідси DataImpulse. Запускається ВРУЧНУ (workflow_dispatch):
// резидентський трафік платний, щоночі ганяти сотні лінків немає сенсу.
//
// Запускати лише в GitHub Actions: з пісочниці агента gw.dataimpulse.com
// недоступний на жодному порту (connection refused), раннери ходять напряму.
//
// Лінки беремо з самого Keitaro: кампанія і є ТДС, її публічне посилання —
// це domain + alias, а гео — з назви кампанії. Окремого джерела не треба.
//
// Секрети (env):
//   KT_PROXY    {"host","port","user","pass"[,"geoMap":{"ZH":"cn"}]}
//   KT_TEAMS    той самий конфіг команд, що й у збірці
//   KT_PASSWORD той самий пароль, що відкриває дашборд
// Входи (env, з workflow_dispatch):
//   TDS_SCOPE  "all" | гео ("IT" / "IT,DK") | назва команди   (типово all)
//   TDS_LIMIT  максимум лінків за прогін                      (типово 400)
//   TDS_UA     "mobile" | "desktop"                           (типово mobile)
//   TDS_FILE   локальний JSON замість Keitaro — для офлайн-тестів
// Вихід: data/tds.enc — той самий формат, що й дані дашборда.
// ─────────────────────────────────────────────────────────────────────────────
import net from "node:net";
import tls from "node:tls";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encryptData } from "./crypto.mjs";
import { parseCampaign } from "./campaign.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log("•", ...a);

const MAX_HOPS     = 15;      // ланцюг трекер → афка → бренд → регіон буває довгим
const HOP_TIMEOUT  = 20_000;
const MAX_BODY     = 48 * 1024;  // більше й не треба: шукаємо редірект і сліди блоку
const CONCURRENCY  = 6;       // не душимо ні проксі, ні цільові сайти
const CHAIN_URL_MAX = 300;

// ── гео → мова, щоб запит не виглядав чужим у своїй же країні ────────────────
const LANG = { IT:"it-IT,it;q=0.9", ES:"es-ES,es;q=0.9", SE:"sv-SE,sv;q=0.9",
  CH:"de-CH,de;q=0.9", HU:"hu-HU,hu;q=0.9", DK:"da-DK,da;q=0.9", GR:"el-GR,el;q=0.9",
  MY:"ms-MY,ms;q=0.9,en;q=0.8", SG:"en-SG,en;q=0.9", TH:"th-TH,th;q=0.9",
  PH:"en-PH,en;q=0.9", CA:"en-CA,en;q=0.9", BR:"pt-BR,pt;q=0.9", CN:"zh-CN,zh;q=0.9",
  DE:"de-DE,de;q=0.9", FR:"fr-FR,fr;q=0.9", NL:"nl-NL,nl;q=0.9", PT:"pt-PT,pt;q=0.9",
  NO:"nb-NO,nb;q=0.9", FI:"fi-FI,fi;q=0.9", AT:"de-AT,de;q=0.9", PL:"pl-PL,pl;q=0.9" };

const UA_MOBILE  = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";


// ── Keitaro: звідки беруться ТДС-лінки ──────────────────────────────────────
// Кампанія в Keitaro і є ТДС: її публічне посилання складається з `domain`
// (готовий URL) і `alias`. Гео беремо з назви кампанії тим самим розбором, що
// й збірка, — саме воно каже, з якої країни має дивитись перевірка.
//
// Активних кампаній близько двох тисяч. Ганяти їх усі через платні
// резидентські проксі безглуздо, тому беремо лише ті, що реально мали трафік
// за останні дні, і йдемо від найбільших: зламаний лінк, через який ніхто не
// ходить, нікому не болить.
const TRAFFIC_DAYS = 7;
// Слот у лінку — це GET-параметр, який Keitaro кладе у sub_id_1, а потоки
// кампанії фільтрують по ньому: один слот = один сайт призначення. Саме через
// це голий лінк без ?slot= віддавав порожню сторінку.
const SLOT_PARAM  = process.env.TDS_SLOT_PARAM  || "slot";
const SLOT_FILTER = process.env.TDS_SLOT_FILTER || "sub_id_1";
const MAX_SLOTS   = 40;     // страховка від кампанії з сотнею потоків
const TZ = "Europe/Kyiv";
const dayAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const num = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };

function ktClient(url, key) {
  const API = String(url).replace(/\/+$/, "") + "/admin_api/v1";
  const headers = { "Api-Key": key, "Content-Type": "application/json" };
  const go = async (path, init) => {
    const r = await fetch(API + path, { headers, ...(init || {}), signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`Keitaro ${path} → HTTP ${r.status}`);
    const j = await r.json();
    return Array.isArray(j) ? j : (j.rows || []);
  };
  return {
    get: go,
    report: (grouping, from, to, metrics) => go("/report/build", {
      method: "POST",
      body: JSON.stringify({
        range: { from: from + " 00:00:00", to: to + " 23:59:59", timezone: TZ },
        grouping, metrics, filters: [], sort: [], summary: false, limit: 100000, offset: 0,
      }),
    }),
  };
}

// scope: "all" | гео через кому ("IT,DK") | назва команди | і те, і те.
function scopeParts(scope) {
  const t = String(scope || "all").split(",").map((x) => x.trim()).filter(Boolean);
  const all = !t.length || t.length === 1 && t[0].toLowerCase() === "all";
  return {
    all,
    geos: t.filter((x) => /^[A-Za-z]{2}$/.test(x)).map((x) => x.toUpperCase()),
    names: t.filter((x) => !/^[A-Za-z]{2}$/.test(x) && x.toLowerCase() !== "all").map((x) => x.toLowerCase()),
  };
}
const wantTeam = (name, sp) => sp.all || !sp.names.length || sp.names.includes(String(name).toLowerCase());
const wantGeo  = (geo,  sp) => sp.all || !sp.geos.length  || sp.geos.includes(geo);

// Які слоти живуть у цій кампанії під це гео. Беремо з потоків, а не вгадуємо:
// потік без фільтра country підходить усім, з фільтром — лише своїм країнам.
function slotsFromStreams(streams, geo) {
  const act = (streams || []).filter((s) => s.state === "active");
  const slotsOf = (s) => {
    const f = (s.filters || []).find((x) => x.name === SLOT_FILTER && x.mode !== "reject");
    return Array.isArray(f?.payload) ? f.payload.map(String) : [];
  };
  const geoFits = (s) => {
    const f = (s.filters || []).find((x) => x.name === "country");
    if (!Array.isArray(f?.payload)) return true;
    const has = f.payload.map((x) => String(x).toUpperCase()).includes(String(geo).toUpperCase());
    return f.mode === "reject" ? !has : has;
  };
  // Спершу потоки саме під це гео; якщо таких немає — беремо всі, бо гео могли
  // просто не прописати, а слоти однаково існують.
  let slots = [...new Set(act.filter(geoFits).flatMap(slotsOf))];
  if (!slots.length) slots = [...new Set(act.flatMap(slotsOf))];
  return slots.sort((a, b) => (Number(a) || 0) - (Number(b) || 0)).slice(0, MAX_SLOTS);
}

async function loadLinks(scope, limit) {
  if (process.env.TDS_FILE) {                       // офлайн-режим для тестів
    const j = JSON.parse(await readFile(process.env.TDS_FILE, "utf8"));
    const links = Array.isArray(j) ? j : j.links;
    log(`Джерело: файл ${process.env.TDS_FILE} — ${links.length} лінків`);
    return { links, offerHosts: new Set() };
  }
  const raw = process.env.KT_TEAMS;
  if (!raw) throw new Error("немає секрету KT_TEAMS — нема звідки брати кампанії");
  const cfg = JSON.parse(raw);
  const teams = (Array.isArray(cfg) ? cfg : cfg.teams) || [];
  const sp = scopeParts(scope);
  const links = [], offerHosts = new Set();

  // Спершу збираємо кандидатів з УСІХ команд і лише потім ріжемо за трафіком.
  // Інакше перші команди вичерпують ліміт, а остання не потрапляє в перевірку
  // взагалі — рівно це й сталось у першому прогоні зі слотами.
  const cand = [];
  for (const T of teams) {
    if (!wantTeam(T.name, sp)) continue;
    const kt = ktClient(T.url, T.key);
    let camps = [], offers = [], traffic = [];
    try {
      [camps, offers] = await Promise.all([kt.get("/campaigns"), kt.get("/offers")]);
      // Якщо звіт не віддався — не падаємо: просто втрачаємо сортування за трафіком.
      traffic = await kt.report(["campaign_id"], dayAgo(TRAFFIC_DAYS), dayAgo(1), ["clicks"]).catch(() => []);
    } catch (e) { log(`[${T.name}] ✖ ${hide(e.message)} — команду пропущено`); continue; }

    for (const o of offers) { const h = hostOf(o.action_payload); if (h) offerHosts.add(h); }
    const clicks = new Map(traffic.map((r) => [String(r.campaign_id), num(r.clicks)]));

    const rows = camps
      .filter((c) => c.state === "active" && c.alias && /^https?:\/\//i.test(String(c.domain || "")))
      .map((c) => ({ c, kt, team: T.name, clicks: clicks.get(String(c.id)) || 0, ...parseCampaign(c.name) }))
      .filter((r) => r.clicks > 0 && wantGeo(r.geo, sp));
    cand.push(...rows);
    log(`[${T.name}] активних ${camps.length} · із трафіком за ${TRAFFIC_DAYS} дн ${rows.length} · оферів ${offers.length}`);
  }
  cand.sort((a, b) => b.clicks - a.clicks);

  // Потоки тягнемо лише для тих кампаній, що реально підуть у перевірку:
  // зайвих запитів по всьому списку робити немає сенсу.
  let withSlots = 0, noSlots = 0;
  for (let i = 0; i < cand.length && links.length < limit; i += 10) {
    const batch = cand.slice(i, i + 10);
    const streams = await Promise.all(batch.map((r) =>
      r.kt.get(`/campaigns/${r.c.id}/streams`).catch(() => [])));
    batch.forEach((r, k) => {
      const base = String(r.c.domain).replace(/\/+$/, "") + "/" + r.c.alias;
      const slots = slotsFromStreams(streams[k], r.geo);
      const common = { tab: r.team, clicks: r.clicks, brand: r.c.name, partner: r.prefix,
                       geoRaw: r.geo, ref: "", row: r.c.id };
      if (slots.length) {
        withSlots++;
        for (const sl of slots) links.push({ ...common, slot: sl,
          url: `${base}?${SLOT_PARAM}=${encodeURIComponent(sl)}` });
      } else {
        noSlots++;
        links.push({ ...common, slot: "", url: base });
      }
    });
  }
  log(`Кампаній-кандидатів ${cand.length} · зі слотами ${withSlots} · без слотів ${noSlots} · лінків ${links.length}`);

  if (!links.length && !sp.all) throw new Error(`під scope="${scope}" не знайшлось кампаній із трафіком`);
  return { links, offerHosts };
}

// ── Тунель через DataImpulse ────────────────────────────────────────────────
// Логін несе параметри таргетингу після "__": cr.<країна> — вихід саме з неї,
// sessid — тримає одну й ту саму IP на весь ланцюг редіректів (інакше кожен
// крок виходив би з нової адреси, і ТДС справедливо вирішив би, що це бот).
function proxyUser(proxy, cc, sess) {
  return `${proxy.user}__cr.${cc};sessid.${sess};sessttl.5`;
}

const PROXY_ERR = {
  407: "проксі не пустив (ліміти або логін)", 403: "проксі заблокував ціль",
  502: "проксі не достукався до хоста", 503: "немає вільної IP у цій країні",
};

function connectTunnel(proxy, cc, sess, host, port) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${proxyUser(proxy, cc, sess)}:${proxy.pass}`).toString("base64");
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false, buf = Buffer.alloc(0);
    const fail = (e) => { if (settled) return; settled = true; clearTimeout(t); sock.destroy(); reject(e); };
    const t = setTimeout(() => fail(Object.assign(new Error("проксі не відповів"), { kind: "proxy" })), HOP_TIMEOUT);
    sock.on("error", (e) => fail(Object.assign(new Error(`проксі: ${e.code || e.message}`), { kind: "proxy" })));
    // Проксі, який мовчки закрив зʼєднання, — теж відповідь: не чекаємо таймауту.
    sock.on("close", () => fail(Object.assign(new Error("проксі закрив зʼєднання"), { kind: "proxy" })));
    sock.once("connect", () => sock.write(
      `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
      `Proxy-Authorization: Basic ${auth}\r\nProxy-Connection: Keep-Alive\r\n\r\n`));
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const i = buf.indexOf("\r\n\r\n");
      if (i < 0) { if (buf.length > 16384) fail(Object.assign(new Error("проксі: дивна відповідь"), { kind: "proxy" })); return; }
      sock.off("data", onData);
      const head = buf.subarray(0, i).toString("latin1");
      const code = Number((head.match(/^HTTP\/\d\.\d (\d{3})/) || [])[1] || 0);
      if (code !== 200) {
        // DataImpulse пояснює причину окремим заголовком — він інформативніший за код.
        const why = (head.match(/x-?(?:error|imp)[^:]*:\s*([^\r\n]+)/i) || [])[1] || PROXY_ERR[code] || `код ${code}`;
        return fail(Object.assign(new Error(`проксі: ${why}`), { kind: "proxy" }));
      }
      settled = true; clearTimeout(t);
      resolve({ sock, rest: buf.subarray(i + 4) });
    };
    sock.on("data", onData);
  });
}

function dechunk(buf) {
  const out = []; let p = 0;
  while (p < buf.length) {
    const nl = buf.indexOf("\r\n", p);
    if (nl < 0) break;
    const n = parseInt(buf.subarray(p, nl).toString("latin1").split(";")[0], 16);
    if (!isFinite(n) || n <= 0) break;
    out.push(buf.subarray(nl + 2, nl + 2 + n));
    p = nl + 2 + n + 2;
  }
  return out.length ? Buffer.concat(out) : buf;
}

// Один HTTP-запит поверх уже відкритого сокета (TLS або голого).
function httpOverSocket(sock, preData, { host, path, headers }) {
  return new Promise((resolve, reject) => {
    let settled = false, buf = preData && preData.length ? Buffer.from(preData) : Buffer.alloc(0);
    const done = (v) => { if (settled) return; settled = true; clearTimeout(t); sock.destroy(); resolve(v); };
    const fail = (e) => { if (settled) return; settled = true; clearTimeout(t); sock.destroy(); reject(e); };
    const t = setTimeout(() => finish(), HOP_TIMEOUT);
    sock.on("error", (e) => {
      // Обрив після того, як заголовки вже прийшли, — це не збій: сервер просто
      // закрив зʼєднання. Віддаємо те, що встигли прочитати.
      if (buf.indexOf("\r\n\r\n") >= 0) finish(); else fail(new Error(e.code || e.message));
    });
    sock.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length >= MAX_BODY + 8192) finish();
    });
    sock.on("end", finish);
    sock.on("close", finish);

    function finish() {
      if (settled) return;
      const i = buf.indexOf("\r\n\r\n");
      if (i < 0) return fail(new Error("порожня відповідь"));
      const head = buf.subarray(0, i).toString("latin1");
      const status = Number((head.match(/^HTTP\/\d\.\d (\d{3})/) || [])[1] || 0);
      const h = {}, cookies = [];
      head.split("\r\n").slice(1).forEach((line) => {
        const j = line.indexOf(":"); if (j <= 0) return;
        const k = line.slice(0, j).trim().toLowerCase(), v = line.slice(j + 1).trim();
        // Set-Cookie приходить кількома рядками — звичайний обʼєкт лишив би останній.
        if (k === "set-cookie") cookies.push(v); else h[k] = v;
      });
      h["set-cookie"] = cookies;
      let body = buf.subarray(i + 4);
      if (/chunked/i.test(h["transfer-encoding"] || "")) body = dechunk(body);
      done({ status, headers: h, cookies, body: body.subarray(0, MAX_BODY).toString("utf8") });
    }

    const lines = [`GET ${path} HTTP/1.1`, `Host: ${host}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    sock.write(lines.join("\r\n") + "\r\n\r\n");
  });
}

// Куки на весь ланцюг. Без них ламається поширений у трекерах прийом
// «постав куку і зредіректь на себе»: клієнт без кук крутиться по колу вічно,
// і перевірка чесно, але хибно рапортує петлю.
function cookieHeader(jar, host) {
  const m = jar.get(root2(host));
  if (!m || !m.size) return "";
  return [...m].map(([k, v]) => `${k}=${v}`).join("; ");
}
function rememberCookies(jar, host, list) {
  if (!list || !list.length) return;
  const key = root2(host);
  if (!jar.has(key)) jar.set(key, new Map());
  const m = jar.get(key);
  for (const raw of list) {
    const pair = String(raw).split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) m.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function oneHop(urlStr, cc, proxy, sess, ua, lang, jar) {
  const u = new URL(urlStr);
  const https = u.protocol === "https:";
  const port = u.port ? Number(u.port) : (https ? 443 : 80);
  const t0 = Date.now();
  const { sock, rest } = await connectTunnel(proxy, cc, sess, u.hostname, port);
  let stream = sock;
  if (https) {
    stream = await new Promise((res, rej) => {
      // Сертифікат перевіряємо по-справжньому: зламаний TLS — це рівно той збій,
      // через який юзер не доходить до сторінки, і його треба показати, а не сховати.
      const s = tls.connect({ socket: sock, servername: u.hostname }, () => { clearTimeout(tt); res(s); });
      const tt = setTimeout(() => { s.destroy(); rej(new Error("TLS: таймаут")); }, HOP_TIMEOUT);
      s.once("error", (e) => { clearTimeout(tt); rej(new Error(`TLS: ${e.code || e.message}`)); });
    });
  }
  const r = await httpOverSocket(stream, https ? null : rest, {
    host: u.host, path: (u.pathname || "/") + (u.search || ""),
    headers: {
      "User-Agent": ua,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": lang,
      "Accept-Encoding": "identity",   // без gzip — інакше довелось би розпаковувати заради одного рядка
      "Upgrade-Insecure-Requests": "1",
      "Connection": "close",
      ...(jar && cookieHeader(jar, u.hostname) ? { Cookie: cookieHeader(jar, u.hostname) } : {}),
    },
  });
  if (jar) rememberCookies(jar, u.hostname, r.cookies);
  return { ...r, ms: Date.now() - t0 };
}

// ── Куди веде сторінка далі ─────────────────────────────────────────────────
// ТДС рідко обмежується 30x: половина ланцюгів іде через meta refresh або
// просте присвоєння location у скрипті. Не підемо за ними — вирішимо, що
// ланцюг обірвався, хоча в браузері він живий.
function nextUrl(r, cur) {
  if (r.status >= 300 && r.status < 400 && r.headers.location) {
    return { url: abs(r.headers.location, cur), via: "30" + (r.status % 10) };
  }
  // Беремо тег цілком і вже в ньому шукаємо url: у живих ТДС трапляється і
  // content="0;URL='/x'", і без лапок зовсім — розбір самого content на цьому ламався.
  const meta = r.body.match(/<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/i);
  if (meta) {
    const m = meta[0].match(/url\s*=\s*["']?\s*([^"'>\s]+)/i);
    if (m) return { url: abs(m[1].replace(/['"]+$/, ""), cur), via: "meta" };
  }
  const js = r.body.match(/(?:window\.|top\.|document\.)?location(?:\.href)?\s*=\s*["']([^"']{6,})["']/i)
          || r.body.match(/location\.(?:replace|assign)\s*\(\s*["']([^"']{6,})["']/i);
  if (js) return { url: abs(js[1], cur), via: "js" };
  return null;
}
function abs(href, base) { try { return new URL(href, base).toString(); } catch { return null; } }

const BLOCK_SIGN = [
  /just a moment/i, /cf-browser-verification/i, /checking your browser/i,
  /attention required/i, /access denied/i, /request blocked/i, /403 forbidden/i,
  /sorry, you have been blocked/i, /ray id/i,
];
const looksBlocked = (body) => BLOCK_SIGN.some((re) => re.test(body));

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; } };
const root2  = (h) => h.split(".").slice(-2).join(".");
const sameHost = (a, b) => !!a && !!b && (a === b || root2(a) === root2(b));
const titleOf = (body) => (body.match(/<title[^>]*>([\s\S]{0,120}?)<\/title>/i) || [])[1]?.replace(/\s+/g, " ").trim() || "";

async function checkLink(link, proxy, ua, offerHosts) {
  const cc = ccOf(link.geoRaw, proxy);
  if (!cc) return { verdict: "skip", note: `невідоме гео «${link.geoRaw || "—"}»`, chain: [] };
  const sess = Math.floor(Math.random() * 1e9);
  const lang = LANG[cc.toUpperCase()] || "en-US,en;q=0.9";
  const chain = [], jar = new Map();
  let cur = link.url, loop = false, tooLong = false, err = null;
  const seen = new Set();

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let r;
    try {
      r = await oneHop(cur, cc, proxy, sess, ua, lang, jar);
    } catch (e) {
      err = e; chain.push({ url: cur, status: 0, via: "—", ms: 0, note: e.message });
      break;
    }
    chain.push({ url: cur, status: r.status, via: "", ms: r.ms, title: titleOf(r.body),
                 len: r.body.length, blocked: looksBlocked(r.body) });
    const nx = nextUrl(r, cur);
    if (!nx || !nx.url) break;
    chain[chain.length - 1].via = nx.via;
    // Та сама адреса з новою кукою — це не коло, а другий крок логіки трекера.
    const mark = nx.url + "|" + cookieHeader(jar, hostOf(nx.url));
    if (seen.has(mark)) { loop = true; break; }
    seen.add(mark);
    cur = nx.url;
    if (hop === MAX_HOPS - 1) tooLong = true;
  }

  const last = chain[chain.length - 1] || {};
  const trackerHost = hostOf(link.url);
  const finalHost = hostOf(last.url);
  // Чи вийшли взагалі за межі самого трекера і чи торкнулись хоч одного офера
  // з довідника Keitaro. Перевіряємо весь ланцюг, а не фінальний хост: офер
  // часто редіректить далі на бренд, якого в довіднику вже немає.
  const left = !!finalHost && !sameHost(finalHost, trackerHost);
  const known = offerHosts && offerHosts.size;
  const touchedOffer = !!known && chain.some((c) => offerHosts.has(hostOf(c.url)));

  let verdict, note = "";
  if (err && err.kind === "proxy") { verdict = "proxy"; note = err.message; }
  else if (err)                    { verdict = "dead";  note = err.message; }
  else if (loop)                   { verdict = "loop";  note = `редірект ходить по колу (крок ${chain.length})`; }
  // Коло і «не встигли дійти» — різні діагнози: перше зламане, друге може
  // виявитись просто довгим маршрутом. Злиті в один вердикт вони приховували,
  // що саме сталось.
  else if (tooLong)                { verdict = "long";  note = `ланцюг не завершився за ${MAX_HOPS} кроків`; }
  else if (last.blocked || last.status === 403 || last.status === 451) { verdict = "blocked"; note = last.title || `HTTP ${last.status}`; }
  else if (last.status >= 400)     { verdict = "http";  note = `HTTP ${last.status}`; }
  else if (last.status === 0)      { verdict = "dead";  note = last.note || "немає відповіді"; }
  // Лишились на домені трекера. Порожня відповідь — це «під це гео й девайс не
  // підібрався жоден потік»; змістовна сторінка — найімовірніше локальний ленд,
  // з якого юзер іде далі кліком, а клікати перевірка не вміє.
  else if (!left && (last.len || 0) < 500) { verdict = "empty";  note = "трекер віддав порожню сторінку — під це гео/девайс не підібрався потік"; }
  else if (!left)                  { verdict = "lander"; note = last.title ? `ленд на домені трекера: ${last.title}` : "ленд на домені трекера — далі потрібен клік"; }
  else if (known && !touchedOffer) { verdict = "mismatch"; note = `вийшли на ${finalHost} — цього хоста немає серед оферів Keitaro`; }
  else                             { verdict = "ok"; }

  return { verdict, note, chain, cc, finalHost, refHost: trackerHost,
           ms: chain.reduce((s, c) => s + (c.ms || 0), 0) };
}

// Гео з таблиці → код країни для проксі. Комірка буває як «IT», так і «MY,SG,TH,PH».
function ccOf(raw, proxy) {
  const map = { ZH: "cn", UK: "gb", ...(proxy.geoMap || {}) };
  const first = String(raw || "").split(/[,/;|\s]+/).map((s) => s.trim()).filter(Boolean)[0] || "";
  if (!first) return "";
  const up = first.toUpperCase();
  if (map[up]) return String(map[up]).toLowerCase();
  return /^[A-Z]{2}$/.test(up) ? up.toLowerCase() : "";
}

// ── Прогін ──────────────────────────────────────────────────────────────────
// Логи Actions публічні, а ТДС-лінки й бренди — ні. Тому в CI друкуємо лише
// цифри: що саме зламалось, видно в дашборді, який і так під паролем.
const CI = !!process.env.CI;
// Ховаємо адреси й хости, але НЕ сам текст помилки: інакше причина падіння
// перетворюється на «***», і з логу неможливо зрозуміти, чого бракує.
const hide = (s) => {
  if (!CI) return String(s);
  return String(s)
    .replace(/https?:\/\/[^\s/)"']+/gi, "http://***")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "***");
};

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      try { out[k] = await fn(items[k], k); }
      catch (e) { out[k] = { verdict: "dead", note: String(e.message || e), chain: [] }; }
      if (++done % 25 === 0 || done === items.length) log(`  … ${done}/${items.length}`);
    }
  }));
  return out;
}

const VERDICTS = ["ok", "lander", "mismatch", "empty", "blocked", "http", "dead", "loop", "long", "proxy", "skip"];

// Разовий зонд: що саме Keitaro знає про кампанії й домени. Потрібен, бо
// вгадувати поля тут означало б будувати лінки, яких не існує. У публічний
// лог ідуть лише назви полів і форма даних — ні хостів, ні аліасів.
async function probeKeitaro() {
  const raw = process.env.KT_TEAMS;
  if (!raw) throw new Error("немає секрету KT_TEAMS");
  const teams = JSON.parse(raw);
  const T = (Array.isArray(teams) ? teams : teams.teams)[0];
  const API = String(T.url).replace(/\/+$/, "") + "/admin_api/v1";
  const headers = { "Api-Key": T.key, "Content-Type": "application/json" };
  const get = async (path) => {
    const r = await fetch(API + path, { headers, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) return { err: r.status };
    const j = await r.json();
    return Array.isArray(j) ? j : (j.rows || j);
  };
  // Потоки саме тих кампаній, що мають трафік: перші за списком — інше
  // покоління (один потік без фільтрів), і по них не видно, звідки slot.
  const camps0 = await get("/campaigns");
  const all0 = Array.isArray(camps0) ? camps0 : [];
  let top = all0.slice(0, 5);
  try {
    const rep = await fetch(API + "/report/build", {
      method: "POST", headers,
      body: JSON.stringify({ range: { from: dayAgo(7) + " 00:00:00", to: dayAgo(1) + " 23:59:59", timezone: TZ },
        grouping: ["campaign_id"], metrics: ["clicks"], filters: [], sort: [], summary: false, limit: 100000, offset: 0 }),
      signal: AbortSignal.timeout(120_000),
    }).then((r) => r.json());
    const cl = new Map((rep.rows || []).map((r) => [String(r.campaign_id), Number(r.clicks) || 0]));
    top = all0.filter((c) => (cl.get(String(c.id)) || 0) > 0)
              .sort((a, b) => (cl.get(String(b.id)) || 0) - (cl.get(String(a.id)) || 0)).slice(0, 5);
    log(`кампаній із трафіком: ${all0.filter((c) => (cl.get(String(c.id)) || 0) > 0).length}`);
  } catch (e) { log(`звіт не віддався: ${hide(e.message)}`); }

  for (const c of top) {
    const st = await get(`/campaigns/${c.id}/streams`);
    if (st.err) { log(`streams → HTTP ${st.err}`); continue; }
    const arr = Array.isArray(st) ? st : [st];
    // Аліас показуємо формою, не текстом: сам по собі він частина бойового лінка.
    const shape = String(c.alias || "").replace(/[a-z]/gi, "a").replace(/\d/g, "9");
    log(`кампанія alias~${shape} (${String(c.alias||"").length} симв.) · параметри:${JSON.stringify(c.parameters||[]).slice(0,160)} · потоків ${arr.length}`);
    arr.slice(0, 15).forEach((x, i) => {
      const f = JSON.stringify(x.filters || []).replace(/"https?:\/\/[^"]*"/g, '"URL"');
      log(`   #${i + 1} ${x.type}/${x.action_type} pos=${x.position} w=${x.weight} ${x.state}` +
          ` ленди=${(x.landings || []).length} офери=${(x.offers || []).length} фільтри=${f.slice(0, 260)}`);
    });
  }

  for (const path of ["/campaigns", "/domains", "/offers"]) {
    const j = await get(path);
    if (j.err) { log(`${path} → HTTP ${j.err}`); continue; }
    const arr = Array.isArray(j) ? j : [j];
    log(`${path} → ${arr.length} записів`);
    if (!arr.length) continue;
    log(`  поля: ${Object.keys(arr[0]).join(", ")}`);
    // форма значень: тип і довжина, без самих значень
    const shape = Object.entries(arr[0]).map(([k, v]) =>
      `${k}:${v === null ? "null" : Array.isArray(v) ? `[${v.length}]` : typeof v === "object" ? "{}" : typeof v === "string" ? `str${v.length}` : typeof v}`);
    log(`  форма: ${shape.join(" ")}`);
    if (path === "/campaigns") {
      const withAlias = arr.filter((c) => c.alias).length;
      const withDomain = arr.filter((c) => c.domain_id).length;
      const states = [...new Set(arr.map((c) => c.state))].join("/");
      log(`  з alias: ${withAlias} · з domain_id: ${withDomain} · стани: ${states}`);
      const linkish = Object.keys(arr[0]).filter((k) => /link|url|domain|alias/i.test(k));
      log(`  схоже на посилання: ${linkish.join(", ") || "нічого"}`);
      for (const k of linkish) {
        const v = arr[0][k];
        log(`    ${k} = ${typeof v === "string" ? (/^https?:\/\//.test(v) ? "URL(" + v.length + ")" : "«" + v.replace(/[^\/?=&.]/g, "•") + "»") : JSON.stringify(v)?.slice(0, 80)}`);
      }
    }
  }
}

// Перевірка самого проксі, без таблиці. Потрібна, бо це єдиний шматок, який
// неможливо прогнати локально: з пісочниці шлюз DataImpulse недосяжний.
// Друкуємо країну й провайдера, але НЕ саму IP — у публічному лозі їй не місце.
async function selfTest(proxy, ua) {
  const ccs = (process.env.TDS_SELFTEST || "it").split(/[,\s]+/).map(c => c.trim().toLowerCase()).filter(Boolean);
  log(`Самоперевірка проксі: ${ccs.length} ${ccs.length === 1 ? "країна" : "країн"}`);
  let bad = 0;
  for (const cc of ccs) {
    const lang = LANG[cc.toUpperCase()] || "en-US,en;q=0.9";
    try {
      const r = await oneHop("https://ipinfo.io/json", cc, proxy, Math.floor(Math.random() * 1e9), ua, lang);
      let j = {}; try { j = JSON.parse(r.body); } catch {}
      const got = String(j.country || "?").toLowerCase();
      const hit = got === cc;
      if (!hit) bad++;
      const isp = j.org ? " · " + String(j.org).replace(/^AS\d+\s*/, "").slice(0, 30) : "";
      log(`  ${cc.toUpperCase()}: HTTP ${r.status} · вийшли з ${got.toUpperCase()}${isp} · ${r.ms} мс ${hit ? "✓" : "✗ не та країна"}`);
    } catch (e) { bad++; log(`  ${cc.toUpperCase()}: ✗ ${hide(e.message)}`); }
  }
  // Окремо — ланцюг редіректів на справжньому TLS: локально це бачив лише
  // фальшивий проксі на http, тут перевіряємо тунель + сертифікат + переходи.
  try {
    const r = await checkLink({ tab: "selftest", pos: "", brand: "", partner: "",
      geoRaw: ccs[0].toUpperCase(), url: "https://httpbingo.org/redirect/3", ref: "", row: 0 }, proxy, ua);
    log(`  ланцюг редіректів: ${r.verdict} · кроків ${r.chain.length}${r.note ? " · " + hide(r.note) : ""}`);
  } catch (e) { log(`  ланцюг редіректів: не вдалось перевірити — ${hide(e.message)}`); }

  if (bad) throw new Error(`${bad} з ${ccs.length} країн відповіли не так, як треба — перевір логін, ліміти й баланс DataImpulse`);
  log("Проксі працює: виходимо саме з потрібних країн.");
}

async function main() {
  const t0 = Date.now();
  const scope = (process.env.TDS_SCOPE || "all").trim() || "all";
  const limit = Math.max(1, Number(process.env.TDS_LIMIT || 400));
  const uaKind = (process.env.TDS_UA || "mobile").toLowerCase();
  const ua = uaKind === "desktop" ? UA_DESKTOP : UA_MOBILE;

  if (process.env.TDS_PROBE) return probeKeitaro();

  const proxy = JSON.parse(process.env.KT_PROXY || "null");
  if (!proxy || !proxy.host || !proxy.user) throw new Error("немає секрету KT_PROXY");
  proxy.port = Number(proxy.port || 823);

  if (process.env.TDS_SELFTEST) return selfTest(proxy, ua);

  // Ліміт рахується в лінках, а не в кампаніях: у однієї кампанії слотів буває
  // з десяток, і без цього прогін роздувся б на тисячі запитів.
  let { links, offerHosts } = await loadLinks(scope, limit);
  const total = links.length;
  // Список уже відсортований за трафіком, тож ліміт відрізає найменш важливе.
  if (links.length > limit) { log(`Лінків ${total}, ліміт ${limit} — беремо ${limit} найтрафіковіших`); links = links.slice(0, limit); }
  if (!links.length) throw new Error("не знайшов жодного ТДС-лінка");

  log(`Перевіряю ${links.length} лінків (${uaKind}, по ${CONCURRENCY} паралельно)…`);
  const res = await pool(links, CONCURRENCY, (l) => checkLink(l, proxy, ua, offerHosts));

  const tabs = [...new Set(links.map((l) => l.tab))];
  const stat = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  const rows = [], chains = [];
  links.forEach((l, k) => {
    const r = res[k] || { verdict: "dead", note: "без результату", chain: [] };
    stat[r.verdict] = (stat[r.verdict] || 0) + 1;
    rows.push([tabs.indexOf(l.tab), l.clicks || 0, l.brand, l.partner, l.geoRaw, r.cc || "",
      r.verdict, r.finalHost || "", r.refHost || "", (r.chain || []).length,
      r.ms || 0, r.note || "", l.url.slice(0, CHAIN_URL_MAX), l.row, l.slot || ""]);
    chains.push((r.chain || []).map((c) => [String(c.url).slice(0, CHAIN_URL_MAX),
      c.status, c.via || "", c.ms || 0, (c.title || "").slice(0, 90), c.note || ""]));
  });

  const DATA = {
    checkedAt: new Date().toISOString(),
    generated: new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" }),
    scope, ua: uaKind, total, checked: links.length, stat, tabs, rows, chains,
    source: "keitaro", trafficDays: TRAFFIC_DAYS, offerHosts: offerHosts.size,
    slotParam: SLOT_PARAM,
  };

  const password = process.env.KT_PASSWORD || "";
  const outPath = join(__dir, "data", "tds.enc");
  await mkdir(dirname(outPath), { recursive: true });
  if (password) {
    const { b64 } = await encryptData(JSON.stringify(DATA), password);
    await writeFile(outPath, b64, "utf8");
    log(`🔒 результат зашифровано → data/tds.enc (${(b64.length / 1024).toFixed(0)} KB)`);
  } else {
    await writeFile(join(__dir, "data", "tds.json"), JSON.stringify(DATA, null, 1), "utf8");
    log("⚠ без KT_PASSWORD — поклав відкритий data/tds.json (лише для локальних тестів)");
  }

  const bad = links.length - stat.ok;
  // Розподіл довжини ланцюга — єдиний спосіб зрозуміти з публічного логу,
  // чи вистачає MAX_HOPS, не показуючи самих адрес.
  const lens = chains.map((c) => c.length).sort((a, b) => a - b);
  const p = (q) => lens[Math.min(lens.length - 1, Math.floor(lens.length * q))] || 0;
  log(`Кроків у ланцюгу: медіана ${p(0.5)} · 90% ${p(0.9)} · максимум ${lens[lens.length - 1] || 0} (ліміт ${MAX_HOPS})`);
  log(`Готово за ${((Date.now() - t0) / 1000).toFixed(0)}s · ok ${stat.ok} · проблемних ${bad}`);
  log(VERDICTS.filter((v) => stat[v]).map((v) => `${v}: ${stat[v]}`).join(" · "));
  if (stat.proxy && stat.proxy === links.length) throw new Error("жоден лінк не пройшов через проксі — перевір KT_PROXY і баланс DataImpulse");
}

// Запускаємось лише коли файл викликали напряму — щоб чисті функції
// (розбір вкладок, вердикти) можна було імпортувати в тестах.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error("✖", hide(e.message)); process.exit(1); });
}

export { scopeParts, wantTeam, wantGeo, ccOf, nextUrl, looksBlocked, sameHost, dechunk };
