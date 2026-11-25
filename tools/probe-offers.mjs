// Разовий зонд: з'ясувати, які поля Keitaro віддає по оферах і партнерських
// мережах, щоб таблиця постбеків будувалась на реальній схемі, а не на здогадках.
// У лог ідуть ЛИШЕ назви полів і лічильники — жодних назв, URL чи ключів.
const cfg = JSON.parse(process.env.KT_TEAMS || "{}");
const TEAMS = cfg.teams || [];
const log = (...a) => console.log("•", ...a);

const shape = (o) => Object.entries(o).map(([k, v]) => {
  const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  const extra = t === "string" ? (v.length ? "" : ":empty") : (t === "number" ? ":" + (v === 0 ? "0" : "n") : "");
  return k + "=" + t + extra;
}).join(", ");

const SUBID = /\{subid\}|\{external_id\}|\{sub_id\}|subid=|\{clickid\}|\{click_id\}/i;

for (let i = 0; i < TEAMS.length; i++) {
  const T = TEAMS[i];
  const API = String(T.url).replace(/\/+$/, "") + "/admin_api/v1";
  const h = { "Api-Key": T.key, "Content-Type": "application/json" };
  const get = async (p) => {
    const r = await fetch(API + p, { headers: h });
    if (!r.ok) throw new Error(p + " → HTTP " + r.status);
    const j = await r.json();
    return Array.isArray(j) ? j : (j.rows || j);
  };
  log(`=== команда #${i} ===`);

  try {
    const nets = await get("/affiliate_networks");
    log(`  affiliate_networks: ${nets.length}`);
    if (nets.length) {
      log(`    поля: ${shape(nets[0])}`);
      const keys = Object.keys(nets[0]);
      for (const k of keys) {
        const nonEmpty = nets.filter(n => n[k] !== null && n[k] !== "" && n[k] !== 0 && n[k] !== undefined).length;
        if (nonEmpty !== nets.length) log(`    непорожніх ${k}: ${nonEmpty}/${nets.length}`);
      }
    }
  } catch (e) { log(`    ✖ affiliate_networks: ${e.message.replace(/https?:\/\/[^\s]+/g, "<url>")}`); }

  try {
    const offers = await get("/offers");
    log(`  offers: ${offers.length}`);
    if (offers.length) {
      log(`    поля: ${shape(offers[0])}`);
      const cnt = (f) => offers.filter(f).length;
      log(`    affiliate_network_id > 0: ${cnt(o => Number(o.affiliate_network_id) > 0)}/${offers.length}`);
      const st = {}; offers.forEach(o => { st[o.state ?? "—"] = (st[o.state ?? "—"] || 0) + 1; });
      log(`    state: ${JSON.stringify(st)}`);
      const ar = {}; offers.forEach(o => { ar[String(o.archive ?? "—")] = (ar[String(o.archive ?? "—")] || 0) + 1; });
      log(`    archive: ${JSON.stringify(ar)}`);
      log(`    url містить макрос subid/clickid: ${cnt(o => SUBID.test(String(o.url || "")))}/${offers.length}`);
      const pbKeys = Object.keys(offers[0]).filter(k => /postback|pixel|s2s/i.test(k));
      log(`    поля зі словом postback/pixel/s2s: ${pbKeys.length ? pbKeys.join(", ") : "немає"}`);
    }
    const lim = await get("/offers?limit=5000");
    log(`    з ?limit=5000: ${lim.length} (однаково = пагінації нема)`);
  } catch (e) { log(`    ✖ offers: ${e.message.replace(/https?:\/\/[^\s]+/g, "<url>")}`); }

  // чи віддає звіт offer_id — від цього залежить, чи матчити офери за назвою
  try {
    const d = new Date(); d.setDate(d.getDate() - 7);
    const from = d.toISOString().slice(0, 10), to = new Date().toISOString().slice(0, 10);
    const r = await fetch(API + "/report/build", {
      method: "POST", headers: h,
      body: JSON.stringify({ range: { from: from + " 00:00:00", to: to + " 23:59:59", timezone: "Europe/Kyiv" },
        grouping: ["offer"], metrics: ["clicks", "conversions"], filters: [], sort: [], summary: false, limit: 3, offset: 0 }),
    });
    const j = await r.json();
    const rows = Array.isArray(j) ? j : (j.rows || []);
    log(`  report[offer] рядків: ${rows.length}${rows.length ? ` · поля: ${Object.keys(rows[0]).join(", ")}` : ""}`);
  } catch (e) { log(`    ✖ report: ${e.message.replace(/https?:\/\/[^\s]+/g, "<url>")}`); }
}
