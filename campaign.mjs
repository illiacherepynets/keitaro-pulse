// Розбір назви кампанії — спільний для збірки й для перевірки ТДС.
// Гео тут не косметика: саме з нього береться країна, з якої перевіряти лінк,
// тож один і той самий розбір має бути в обох скриптах.
export const GEOS = new Set(("IT NL DE FR BE UK GB PL FI HU MY DK ES PT SE NO AT CH IE CA AU US " +
  "JP IN BR MX CL CO AR RU UA TR GR RO CZ SK BG HR SI LT LV EE NZ ZA SG TH VN PH ID KR " +
  "SA AE QA KW IL EG MA NG KE DZ TN LK BD PK").split(" "));

export function parseCampaign(name) {
  const tokens = String(name).split(/[\s_]+/).filter(Boolean);
  let geo = "";
  for (const t of tokens) { if (/^[A-Z]{2}$/.test(t) && GEOS.has(t)) { geo = t === "GB" ? "UK" : t; break; } }
  const prefix = tokens[0] && /^[A-Z0-9]{2,}$/.test(tokens[0]) ? tokens[0] : "—";
  return { prefix, geo: geo || "—" };
}
