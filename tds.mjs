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
// Секрети (env):
//   KT_PROXY    {"host","port","user","pass"[,"geoMap":{"ZH":"cn"}]}
//   KT_GSHEET   {"sheet_id","client_email","private_key"}  — сервісний акаунт Google
//   KT_PASSWORD — той самий пароль, що відкриває дашборд
// Входи (env, з workflow_dispatch):
//   TDS_SCOPE  "all" | "IT" | "IT,DK" | точна назва вкладки   (типово all)
//   TDS_LIMIT  максимум лінків за прогін                      (типово 400)
//   TDS_UA     "mobile" | "desktop"                           (типово mobile)
//   TDS_FILE   локальний JSON замість таблиці — для офлайн-тестів
// Вихід: data/tds.enc — той самий формат, що й дані дашборда.
// ─────────────────────────────────────────────────────────────────────────────
import net from "node:net";
import tls from "node:tls";
import { createSign } from "node:crypto";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encryptData } from "./crypto.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log("•", ...a);

const MAX_HOPS     = 10;      // довші ланцюги — це вже петля, а не маршрутизація
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

// Вкладки з паролями партнерських кабінетів читати НЕ можна — ні в дашборд,
// ні в лог. Відсікаємо за назвою, а потім ще раз за назвою колонки.
const TAB_DENY = /partner|пароли|passwords|accounts/i;
const COL_DENY = /pass|парол|login|логин|логін|token|2fa|e-?mail|почта|пошта/i;

// ── Google Sheets: сервісний акаунт → читання лише потрібних вкладок ─────────
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");

async function googleToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head  = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now,
  }));
  // Секрет у GitHub часто зберігають із літеральними \n — повертаємо переноси.
  const pem = String(sa.private_key || "").replace(/\\n/g, "\n");
  const sig = createSign("RSA-SHA256").update(`${head}.${claim}`).sign(pem);
  const jwt = `${head}.${claim}.${b64url(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new Error(`Google OAuth ${res.status}: ${j.error_description || j.error || "без токена"}`);
  }
  return j.access_token;
}

async function sheetsGet(path, token) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(60_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${j.error?.message || "помилка"}`);
  return j;
}

const quoteRange = (tab) => `'${String(tab).replace(/'/g, "''")}'!A1:Z600`;

// Яку вкладку беремо. scope: "all" | список гео | точна назва вкладки.
function wantTab(title, scope) {
  if (TAB_DENY.test(title)) return false;            // там паролі — не чіпаємо
  if (/^all project/i.test(title)) return false;     // це карта сайтів, не лінки
  if (scope === "all") return true;
  const want = scope.split(",").map((s) => s.trim()).filter(Boolean);
  return want.some((w) =>
    w.toLowerCase() === title.trim().toLowerCase() ||
    (/^[A-Za-z]{2}$/.test(w) && new RegExp(`(^|[_\\s])${w}(\\s|_|$)`, "i").test(title)));
}

const norm = (s) => String(s ?? "").trim();
const low  = (s) => norm(s).toLowerCase();

// Шапка в цих вкладках стоїть не завжди в першому рядку (зверху буває обʼєднаний
// заголовок проєкту), тому шукаємо рядок, де є колонка TDS.
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const r = rows[i] || [];
    if (r.some((c) => /^tds\b/i.test(norm(c)))) return i;
  }
  return -1;
}

function parseTab(title, rows) {
  const hi = findHeader(rows);
  if (hi < 0) return { links: [], why: "немає колонки TDS" };
  const head = (rows[hi] || []).map(norm);
  const col = (re) => head.findIndex((h) => re.test(h) && !COL_DENY.test(h));
  const cTds   = col(/^tds\b/i);
  const cGeo   = col(/^geo\b/i);
  const cBrand = col(/^brand\b/i);
  const cPart  = col(/^partners?\b/i);
  const cPos   = col(/^pos\b/i);
  const cRefNew= col(/^new\s*ref\s*link/i);
  const cRefOld= col(/^ref\s*link/i);
  const tabGeo = (title.match(/[_\s]([A-Za-z]{2})\s*$/) || [])[1] || "";

  const links = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const url = norm(r[cTds]);
    if (!/^https?:\/\//i.test(url)) continue;
    const ref = norm(cRefNew >= 0 ? r[cRefNew] : "") || norm(cRefOld >= 0 ? r[cRefOld] : "");
    links.push({
      tab: title,
      pos: cPos >= 0 ? norm(r[cPos]) : "",
      brand: cBrand >= 0 ? norm(r[cBrand]) : "",
      partner: cPart >= 0 ? norm(r[cPart]) : "",
      geoRaw: (cGeo >= 0 ? norm(r[cGeo]) : "") || tabGeo,
      url,
      ref: /^https?:\/\//i.test(ref) ? ref : "",
      row: i + 1,
    });
  }
  return { links, why: "" };
}

async function loadLinks(scope) {
  if (process.env.TDS_FILE) {                       // офлайн-режим для тестів
    const j = JSON.parse(await readFile(process.env.TDS_FILE, "utf8"));
    const links = Array.isArray(j) ? j : j.links;
    log(`Джерело: файл ${process.env.TDS_FILE} — ${links.length} лінків`);
    return links;
  }
  const raw = process.env.KT_GSHEET;
  if (!raw) throw new Error("немає секрету KT_GSHEET — нічим читати таблицю");
  const sa = JSON.parse(raw);
  const id = sa.sheet_id || process.env.KT_SHEET_ID;
  if (!id) throw new Error("у KT_GSHEET немає sheet_id");
  const token = await googleToken(sa);
  const meta = await sheetsGet(`${id}?fields=properties.title,sheets.properties.title`, token);
  const all = (meta.sheets || []).map((s) => s.properties.title);
  const take = all.filter((t) => wantTab(t, scope));
  log(CI ? `Таблиця: вкладок ${all.length}, беремо ${take.length}`
         : `Таблиця «${meta.properties?.title || "?"}»: вкладок ${all.length}, беремо ${take.length}`);
  if (!take.length) throw new Error(`жодна вкладка не підійшла під scope="${scope}"`);

  const links = [];
  for (let i = 0; i < take.length; i += 20) {        // batchGet обмежений довжиною URL
    const part = take.slice(i, i + 20);
    const qs = part.map((t) => `ranges=${encodeURIComponent(quoteRange(t))}`).join("&");
    const j = await sheetsGet(`${id}/values:batchGet?${qs}&majorDimension=ROWS`, token);
    (j.valueRanges || []).forEach((vr, k) => {
      const { links: L, why } = parseTab(part[k], vr.values || []);
      if (why) log(CI ? `  ⚠ одну вкладку пропущено: ${why}` : `  ⚠ ${part[k]}: ${why}`);
      links.push(...L);
    });
  }
  return links;
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
      const h = {};
      head.split("\r\n").slice(1).forEach((line) => {
        const j = line.indexOf(":"); if (j > 0) h[line.slice(0, j).trim().toLowerCase()] = line.slice(j + 1).trim();
      });
      let body = buf.subarray(i + 4);
      if (/chunked/i.test(h["transfer-encoding"] || "")) body = dechunk(body);
      done({ status, headers: h, body: body.subarray(0, MAX_BODY).toString("utf8") });
    }

    const lines = [`GET ${path} HTTP/1.1`, `Host: ${host}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    sock.write(lines.join("\r\n") + "\r\n\r\n");
  });
}

async function oneHop(urlStr, cc, proxy, sess, ua, lang) {
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
    },
  });
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

async function checkLink(link, proxy, ua) {
  const cc = ccOf(link.geoRaw, proxy);
  if (!cc) return { verdict: "skip", note: `невідоме гео «${link.geoRaw || "—"}»`, chain: [] };
  const sess = Math.floor(Math.random() * 1e9);
  const lang = LANG[cc.toUpperCase()] || "en-US,en;q=0.9";
  const chain = [];
  let cur = link.url, loop = false, tooLong = false, err = null;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let r;
    try {
      r = await oneHop(cur, cc, proxy, sess, ua, lang);
    } catch (e) {
      err = e; chain.push({ url: cur, status: 0, via: "—", ms: 0, note: e.message });
      break;
    }
    chain.push({ url: cur, status: r.status, via: "", ms: r.ms, title: titleOf(r.body),
                 blocked: looksBlocked(r.body) });
    const nx = nextUrl(r, cur);
    if (!nx || !nx.url) break;
    chain[chain.length - 1].via = nx.via;
    if (chain.some((c) => c.url === nx.url)) { loop = true; break; }
    cur = nx.url;
    if (hop === MAX_HOPS - 1) tooLong = true;
  }

  const last = chain[chain.length - 1] || {};
  const refHost = hostOf(link.ref);
  const passedRef = !refHost || chain.some((c) => sameHost(hostOf(c.url), refHost));

  let verdict, note = "";
  if (err && err.kind === "proxy") { verdict = "proxy"; note = err.message; }
  else if (err)                    { verdict = "dead";  note = err.message; }
  else if (loop)                   { verdict = "loop";  note = `редірект ходить по колу (крок ${chain.length})`; }
  else if (tooLong)                { verdict = "loop";  note = `ланцюг не завершився за ${MAX_HOPS} кроків`; }
  else if (last.blocked || last.status === 403 || last.status === 451) { verdict = "blocked"; note = last.title || `HTTP ${last.status}`; }
  else if (last.status >= 400)     { verdict = "http";  note = `HTTP ${last.status}`; }
  else if (last.status === 0)      { verdict = "dead";  note = last.note || "немає відповіді"; }
  else if (!passedRef)             { verdict = "mismatch"; note = `очікували ${refHost}, прийшли на ${hostOf(last.url)}`; }
  else                             { verdict = "ok"; }

  return { verdict, note, chain, cc, finalHost: hostOf(last.url), refHost,
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

const VERDICTS = ["ok", "mismatch", "blocked", "http", "dead", "loop", "proxy", "skip"];

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
    const r = await request(API + path, { headers }, "GET " + path);
    if (!r.ok) return { err: r.status };
    const j = await r.json();
    return Array.isArray(j) ? j : (j.rows || j);
  };
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

  let links = await loadLinks(scope);
  const total = links.length;
  if (links.length > limit) { log(`Лінків ${total}, ліміт ${limit} — беремо перші ${limit}`); links = links.slice(0, limit); }
  if (!links.length) throw new Error("не знайшов жодного ТДС-лінка");

  log(`Перевіряю ${links.length} лінків (${uaKind}, по ${CONCURRENCY} паралельно)…`);
  const res = await pool(links, CONCURRENCY, (l) => checkLink(l, proxy, ua));

  const tabs = [...new Set(links.map((l) => l.tab))];
  const stat = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  const rows = [], chains = [];
  links.forEach((l, k) => {
    const r = res[k] || { verdict: "dead", note: "без результату", chain: [] };
    stat[r.verdict] = (stat[r.verdict] || 0) + 1;
    rows.push([tabs.indexOf(l.tab), l.pos, l.brand, l.partner, l.geoRaw, r.cc || "",
      r.verdict, r.finalHost || "", r.refHost || "", (r.chain || []).length,
      r.ms || 0, r.note || "", l.url.slice(0, CHAIN_URL_MAX), l.row]);
    chains.push((r.chain || []).map((c) => [String(c.url).slice(0, CHAIN_URL_MAX),
      c.status, c.via || "", c.ms || 0, (c.title || "").slice(0, 90), c.note || ""]));
  });

  const DATA = {
    checkedAt: new Date().toISOString(),
    generated: new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" }),
    scope, ua: uaKind, total, checked: links.length, stat, tabs, rows, chains,
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
  log(`Готово за ${((Date.now() - t0) / 1000).toFixed(0)}s · ok ${stat.ok} · проблемних ${bad}`);
  log(VERDICTS.filter((v) => stat[v]).map((v) => `${v}: ${stat[v]}`).join(" · "));
  if (stat.proxy && stat.proxy === links.length) throw new Error("жоден лінк не пройшов через проксі — перевір KT_PROXY і баланс DataImpulse");
}

// Запускаємось лише коли файл викликали напряму — щоб чисті функції
// (розбір вкладок, вердикти) можна було імпортувати в тестах.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error("✖", hide(e.message)); process.exit(1); });
}

export { parseTab, wantTab, ccOf, findHeader, nextUrl, looksBlocked, sameHost, dechunk };
