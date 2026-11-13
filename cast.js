/* ===========================================================
   The cast: a portrait for every name that has one, shared by
   the dice game and the poker game. A name that is not on this
   list falls back to its initials.
   =========================================================== */

const PORTRAITS = {
  "sassafras":         { src:"img/sassafras.png" },
  "sister maple":      { src:"img/maple.png" },
  "fizzwick":          { src:"img/fizzwick.png" },
  "ryn":               { src:"img/ryn.png" },
  "vander boone":      { src:"img/vander.png",     framed:true },
  "lyla webb":         { src:"img/lyla.png",       framed:true },
  "mister crossroads": { src:"img/crossroads.webp", framed:true }
};

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));

export function initials(name){
  return String(name).trim().split(/\s+/).map(w => w[0] || "").join("").slice(0, 2).toUpperCase();
}

/* cls: extra classes, e.g. "npc", "lg", "sm" */
export function avatarHTML(name, cls = ""){
  const p = PORTRAITS[String(name).trim().toLowerCase()];
  if (!p) return `<span class="av ${cls}">${esc(initials(name))}</span>`;
  return `<span class="av pic${p.framed ? " framed" : ""} ${cls}"><img src="${p.src}" alt="" draggable="false"></span>`;
}

/* Which tables this device dealt. A list, not one code, so the dealer can open the
   poker table and still be the dealer of the dice table in the other tab. */
const DEALER_KEY = "dmh.dealer";
export function dealerCodes(){
  try { return (localStorage.getItem(DEALER_KEY) || "").split(",").filter(Boolean); } catch { return []; }
}
export function dealerOf(code){ return dealerCodes().includes(code); }
export function markDealer(code){
  try { localStorage.setItem(DEALER_KEY, [...new Set(dealerCodes().concat(code))].slice(-12).join(",")); } catch {}
}
