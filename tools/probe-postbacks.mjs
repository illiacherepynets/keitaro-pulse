// Зонд: чи справді порожній postback_url у мережі означає, що постбеки не
// працюють. Перевіряємо це конверсіями: якщо під такими мережами конверсії
// приходять — ознака хибна і стовпець бреше.
// У лог ідуть лише назви полів і лічильники.
const cfg = JSON.parse(process.env.KT_TEAMS || "{}");
const TEAMS = cfg.teams || [];
const log = (...a) => console.log("•", ...a);
const clean = (s) => String(s).replace(/https?:\/\/[^\s"]+/g, "<url>");

const day = (d) => d.toISOString().slice(0, 10);
const to = new Date(); const from = new Date(Date.now() - 29 * 864e5);

for (let i = 0; i < TEAMS.length; i++) {
  const T = TEAMS[i];
  const API = String(T.url).replace(/\/+$/, "") + "/admin_api/v1";
  const h = { "Api-Key": T.key, "Content-Type": "application/json" };
  const get = async (p) => {
    const r = await fetch(API + p, { headers: h });
    if (!r.ok) throw new Error(p + " → HTTP " + r.status);
    const j = await r.json(); return Array.isArray(j) ? j : (j.rows || j);
  };
  const post = async (p, body) => {
    const r = await fetch(API + p, { method: "POST", headers: h, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(p + " → HTTP " + r.status + " " + (await r.text()).slice(0, 120));
    const j = await r.json(); return Array.isArray(j) ? j : (j.rows || []);
  };
  log(`=== команда #${i} ===`);
  try {
    const nets = await get("/affiliate_networks");
    const offers = await get("/offers");
    const netById = new Map(nets.map(n => [n.id, n]));
    const offByName = new Map();
    for (const o of offers) offByName.set(o.name, o);

    // 1) конверсії за 30 днів по оферах — чи є вони під мережами без postback_url
    const rows = await post("/report/build", {
      range: { from: day(from) + " 00:00:00", to: day(to) + " 23:59:59", timezone: "Europe/Kyiv" },
      grouping: ["offer"], metrics: ["clicks", "conversions", "sale_revenue"],
      filters: [], sort: [], summary: false, limit: 100000, offset: 0,
    });
    let withPb = { n: 0, conv: 0 }, noPb = { n: 0, conv: 0 }, noNet = { n: 0, conv: 0 }, unknown = { n: 0, conv: 0 };
    for (const r of rows) {
      const o = offByName.get(r.offer);
      const cv = Number(r.conversions) || 0;
      if (!o) { unknown.n++; unknown.conv += cv; continue; }
      const net = netById.get(o.affiliate_network_id);
      if (!net) { noNet.n++; noNet.conv += cv; continue; }
      const t = String(net.postback_url || "").trim() ? withPb : noPb;
      t.n++; t.conv += cv;
    }
    log(`  оферів у звіті: ${rows.length}`);
    log(`    під мережею з postback_url: ${withPb.n} оферів, ${withPb.conv} конверсій`);
    log(`    під мережею БЕЗ postback_url: ${noPb.n} оферів, ${noPb.conv} конверсій   ← ключовий рядок`);
    log(`    без мережі: ${noNet.n} оферів, ${noNet.conv} конверсій`);
    log(`    офера немає в довіднику: ${unknown.n}, ${unknown.conv} конверсій`);

    // 2) як саме конверсії потрапляють у трекер — дивимось поля журналу
    for (const path of ["/conversions/log", "/conversions"]) {
      try {
        const cl = await post(path, {
          range: { from: day(from) + " 00:00:00", to: day(to) + " 23:59:59", timezone: "Europe/Kyiv" },
          limit: 50, offset: 0, columns: [], filters: [], sort: [],
        });
        log(`  ${path}: ${cl.length} рядків${cl.length ? ` · поля: ${Object.keys(cl[0]).join(", ")}` : ""}`);
        if (cl.length) {
          const k = Object.keys(cl[0]);
          for (const f of ["source", "postback_datetime", "original_status", "status", "is_lead", "conversion_type"]) {
            if (!k.includes(f)) continue;
            const vals = {};
            cl.forEach(c => { const v = c[f] == null ? "null" : (String(c[f]).length > 24 ? "<дані>" : String(c[f])); vals[v] = (vals[v] || 0) + 1; });
            log(`    ${f}: ${JSON.stringify(vals).slice(0, 220)}`);
          }
        }
        break;
      } catch (e) { log(`  ${path}: ${clean(e.message).slice(0, 110)}`); }
    }
  } catch (e) { log(`  ✖ ${clean(e.message).slice(0, 160)}`); }
}
