// Разовий зонд №2: посилання офера лежить в action_payload, а не в url.
// Друкуємо лише назви полів, макроси Keitaro і лічильники.
const cfg = JSON.parse(process.env.KT_TEAMS || "{}");
const TEAMS = cfg.teams || [];
const log = (...a) => console.log("•", ...a);
const MACRO = /\{[a-z0-9_]+\}/gi;

for (let i = 0; i < TEAMS.length; i++) {
  const T = TEAMS[i];
  const API = String(T.url).replace(/\/+$/, "") + "/admin_api/v1";
  const h = { "Api-Key": T.key, "Content-Type": "application/json" };
  const get = async (p) => {
    const r = await fetch(API + p, { headers: h });
    if (!r.ok) throw new Error(p + " → HTTP " + r.status);
    const j = await r.json(); return Array.isArray(j) ? j : (j.rows || j);
  };
  log(`=== команда #${i} ===`);
  try {
    const nets = await get("/affiliate_networks");
    const offers = await get("/offers");
    const byId = new Map(nets.map(n => [n.id, n]));

    const st = {}; nets.forEach(n => { st[n.state ?? "—"] = (st[n.state ?? "—"] || 0) + 1; });
    log(`  мереж: ${nets.length} · state: ${JSON.stringify(st)}`);
    log(`  з postback_url: ${nets.filter(n => String(n.postback_url || "").trim()).length}/${nets.length}` +
        ` · з offer_param: ${nets.filter(n => String(n.offer_param || "").trim()).length}/${nets.length}`);
    // які саме макроси зустрічаються в postback_url мереж (токени Keitaro, не секрети)
    const pm = new Set(); nets.forEach(n => (String(n.postback_url || "").match(MACRO) || []).forEach(m => pm.add(m.toLowerCase())));
    log(`  макроси в postback_url: ${[...pm].sort().join(" ") || "—"}`);
    const op = new Set(); nets.forEach(n => { const v = String(n.offer_param || "").trim(); if (v) op.add(v.replace(/[^a-z0-9_={}&?]/gi, "·").slice(0, 40)); });
    log(`  значень offer_param (різних): ${op.size} → ${[...op].slice(0, 10).join(" | ")}`);

    const pay = offers.filter(o => String(o.action_payload || "").trim()).length;
    log(`  оферів: ${offers.length} · з непорожнім action_payload: ${pay}`);
    const am = new Map();
    offers.forEach(o => (String(o.action_payload || "").match(MACRO) || []).forEach(m => am.set(m.toLowerCase(), (am.get(m.toLowerCase()) || 0) + 1)));
    log(`  макроси в action_payload: ${[...am.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => k + "×" + v).join(" ") || "—"}`);
    const at = {}; offers.forEach(o => { at[o.action_type ?? "—"] = (at[o.action_type ?? "—"] || 0) + 1; });
    log(`  action_type: ${JSON.stringify(at)}`);

    // скільки оферів реально «готові»: є мережа, у мережі є postback_url
    const withNet = offers.filter(o => Number(o.affiliate_network_id) > 0);
    const netOk = withNet.filter(o => String(byId.get(o.affiliate_network_id)?.postback_url || "").trim());
    log(`  оферів з мережею: ${withNet.length}/${offers.length} · у мережі є postback_url: ${netOk.length}`);
    const dup = new Map(); offers.forEach(o => dup.set(o.name, (dup.get(o.name) || 0) + 1));
    log(`  оферів з неунікальною назвою: ${[...dup.values()].filter(v => v > 1).length}`);
  } catch (e) { log(`  ✖ ${e.message.replace(/https?:\/\/[^\s]+/g, "<url>")}`); }
}
