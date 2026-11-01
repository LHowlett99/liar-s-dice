/* ===========================================================
   The Dead Man's Hand: one hand of five-card draw, one player,
   everyone else watching. The room lives in the same Firebase
   path as the dice game, marked game:"poker".
   =========================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, onValue, set, get }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";
import { sfx } from "./sfx.js";

const LS = { room:"dmh.room", dealer:"dmh.dealer", hero:"dmh.hero" };
const RANKS = "23456789TJQKA";
const GLYPH = { S:"♠", H:"♥", D:"♦", C:"♣" };
const DEAD = ["AS", "AC", "8S", "8C", "JD"];
const ONE = { 2:"Deuce", 3:"Three", 4:"Four", 5:"Five", 6:"Six", 7:"Seven", 8:"Eight", 9:"Nine", 10:"Ten", 11:"Jack", 12:"Queen", 13:"King", 14:"Ace" };
const MANY = { 2:"Deuces", 3:"Threes", 4:"Fours", 5:"Fives", 6:"Sixes", 7:"Sevens", 8:"Eights", 9:"Nines", 10:"Tens", 11:"Jacks", 12:"Queens", 13:"Kings", 14:"Aces" };

let db = null, roomRef = null, room = null, roomCode = null;
let isDealer = false, castMode = false, lastSnap = null, seenReveal = null;
let lobbyFilled = false, shadowArmed = false, armTimer = null;
const discard = new Set();

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 9);
const clone = o => JSON.parse(JSON.stringify(o));
const hero = () => room.seats[0];
const house = () => room.seats[1];
const hand = s => s.hand || [];

function toast(msg){
  const t = $("toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("on"), 2600);
}

/* ---------------- cards and hands ---------------- */

const rv = c => RANKS.indexOf(c[0]) + 2;
function newDeck(){
  const d = [];
  for (const r of RANKS) for (const s of "SHDC") d.push(r + s);
  for (let i = d.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

function evalHand(cards){
  const vals = cards.map(rv).sort((a, b) => b - a);
  const flush = cards.every(c => c[1] === cards[0][1]);
  const counts = {};
  vals.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  const groups = Object.keys(counts).map(v => [+v, counts[v]]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const uniq = [...new Set(vals)];
  let straight = 0;
  if (uniq.length === 5){
    if (uniq[0] - uniq[4] === 4) straight = uniq[0];
    else if (uniq.join() === "14,5,4,3,2") straight = 5;
  }
  const dead = DEAD.slice(0, 4).every(c => cards.includes(c));
  let cat;
  if (dead) cat = 9;
  else if (straight && flush) cat = 8;
  else if (groups[0][1] === 4) cat = 7;
  else if (groups[0][1] === 3 && groups[1] && groups[1][1] === 2) cat = 6;
  else if (flush) cat = 5;
  else if (straight) cat = 4;
  else if (groups[0][1] === 3) cat = 3;
  else if (groups[0][1] === 2 && groups[1] && groups[1][1] === 2) cat = 2;
  else if (groups[0][1] === 2) cat = 1;
  else cat = 0;
  const key = [cat].concat((cat === 8 || cat === 4) ? [straight] : groups.map(g => g[0]));
  const top = groups[0][0];
  const name = [
    `${ONE[top]} high`,
    `Pair of ${MANY[top]}`,
    `Two pair, ${MANY[groups[0][0]]} and ${MANY[groups[1] ? groups[1][0] : 0]}`,
    `Three ${MANY[top]}`,
    `Straight, ${ONE[straight]} high`,
    `Flush, ${ONE[top]} high`,
    `Full house, ${MANY[top]} over ${MANY[groups[1] ? groups[1][0] : 0]}`,
    `Four ${MANY[top]}`,
    straight === 14 ? "Royal flush" : `Straight flush, ${ONE[straight]} high`,
    "The Dead Man's Hand"
  ][cat];
  return { cat, key, name, dead };
}
function cmpKeys(a, b){
  for (let i = 0; i < Math.max(a.length, b.length); i++){
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function cardHTML(code, cls = "", attrs = ""){
  if (!code) return `<div class="pc back ${cls}" ${attrs}></div>`;
  const r = code[0] === "T" ? "10" : code[0], g = GLYPH[code[1]];
  const red = code[1] === "H" || code[1] === "D" ? " red" : "";
  return `<div class="pc${red} ${cls}" ${attrs}>
    <span class="idx">${r}<b>${g}</b></span><span class="ctr">${g}</span>
    <span class="idx b">${r}<b>${g}</b></span></div>`;
}
const backs = () => Array.from({ length:5 }, () => cardHTML(null)).join("");

/* ---------------- game actions ---------------- */

function makeRoom(){
  return {
    v:3, game:"poker", phase:"lobby", round:0, stakes:"", openHand:false,
    seats:[
      { id:"hero",  name:"Sassafras", kind:"pc",  claimed:false, hand:[], drew:false, shadow:false },
      { id:"house", name:"The House", kind:"npc", claimed:true,  hand:[], drew:false }
    ],
    deck:[], reveal:null, log:[], secret:[]
  };
}
function logAdd(html){
  room.log = room.log || [];
  room.log.push(html);
  if (room.log.length > 60) room.log = room.log.slice(-60);
}
function secretAdd(html){
  room.secret = room.secret || [];
  room.secret.push(html);
  if (room.secret.length > 30) room.secret = room.secret.slice(-30);
}
async function save(){
  render();
  if (!roomRef) return;
  try { await set(roomRef, clone(room)); }
  catch (e){ toast("Could not reach the table. Check your connection."); }
}

function dealHand(){
  const deck = newDeck(), h = hero(), o = house();
  h.hand = deck.splice(0, 5); o.hand = deck.splice(0, 5);
  h.drew = false; h.shadow = false; o.drew = false;
  room.deck = deck; room.reveal = null; room.secret = [];
  room.phase = "play"; room.round = (room.round || 0) + 1;
  discard.clear(); shadowArmed = false;
  logAdd(`<b>Hand ${room.round}.</b> Five cards each.`);
  save();
}

function heroDraw(){
  const h = hero();
  if (room.phase !== "play" || h.drew || !isHero()) return;
  const idx = [...discard].sort();
  idx.forEach(i => { h.hand[i] = room.deck.shift(); });
  h.drew = true; discard.clear();
  logAdd(idx.length
    ? `<b>${esc(h.name)}</b> throws back ${idx.length} and draws.`
    : `<b>${esc(h.name)}</b> stands pat.`);
  save();
}

function houseDraw(){
  const o = house();
  if (o.drew) return;
  const counts = {};
  o.hand.forEach(c => { counts[c[0]] = (counts[c[0]] || 0) + 1; });
  let keep = o.hand.map((c, i) => counts[c[0]] > 1 ? i : -1).filter(i => i >= 0);
  if (!keep.length){
    let best = 0;
    o.hand.forEach((c, i) => { if (rv(c) > rv(o.hand[best])) best = i; });
    keep = [best];
  }
  let n = 0;
  o.hand = o.hand.map((c, i) => keep.includes(i) ? c : (n++, room.deck.shift()));
  o.drew = true;
  logAdd(n ? `<b>${esc(o.name)}</b> draws ${n}.` : `<b>${esc(o.name)}</b> stands pat.`);
}

function useShadow(){
  const h = hero(), o = house();
  if (room.phase !== "play" || h.shadow) return;
  const dead = new Set(DEAD);
  h.hand = DEAD.slice(); h.shadow = true; h.drew = true;
  const deck = (room.deck || []).filter(c => !dead.has(c));
  o.hand = o.hand.map(c => dead.has(c) ? deck.shift() : c);
  room.deck = deck;
  shadowArmed = false; discard.clear();
  secretAdd(`<b>${esc(h.name)}</b> slips the Dead Man's Hand out of the shadows.`);
  save();
}

function showdown(){
  if (room.phase !== "play") return;
  houseDraw();
  const h = hero(), o = house();
  const hk = evalHand(h.hand), ok = evalHand(o.hand);
  const c = cmpKeys(hk.key, ok.key);
  const winner = c > 0 ? "hero" : c < 0 ? "house" : "tie";
  room.reveal = {
    id: uid(), winner,
    hero:  { name:h.name, hand:h.hand.slice(), rank:hk.name, dead:hk.dead },
    house: { name:o.name, hand:o.hand.slice(), rank:ok.name }
  };
  room.phase = "showdown";
  const verdict = winner === "tie" ? "A dead heat." : `<b>${esc(winner === "hero" ? h.name : o.name)}</b> wins.`;
  logAdd(`<b>Showdown.</b> ${esc(h.name)}: ${esc(hk.name)}. ${esc(o.name)}: ${esc(ok.name)}. ${verdict}`);
  save();
}

/* ---------------- who am I ---------------- */

function isHero(){
  if (!room) return false;
  const h = hero();
  try { return !!h.claimed && !!h.token && localStorage.getItem(LS.hero) === roomCode + ":" + h.token; }
  catch { return false; }
}
function claimHero(){
  const h = hero();
  if (h.claimed && !isHero()) return;
  h.claimed = true; h.token = h.token || uid();
  try { localStorage.setItem(LS.hero, roomCode + ":" + h.token); } catch {}
  save();
  toast(`You are ${h.name}.`);
}

/* ---------------- rendering ---------------- */

function show(view){
  ["wait", "lobby", "table"].forEach(v => { $("view-" + v).hidden = (v !== view); });
}
function render(){
  if (!room){ show("wait"); return; }
  if (room.phase === "lobby"){ show("lobby"); renderLobby(); return; }
  lobbyFilled = false;
  show("table"); renderTable();
}

function renderLobby(){
  const h = hero(), mine = isHero();
  $("lobbyCode").textContent = roomCode;
  $("lobbyHint").textContent = mine
    ? "You are seated. The dealer will deal when everyone is ready."
    : h.claimed
      ? `${h.name} is seated. You will be watching.`
      : `If you are ${h.name}, take the seat. Everyone else, just wait: you are watching.`;
  const taken = h.claimed && !mine;
  const initials = h.name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
  $("heroChairWrap").innerHTML = `<li><button class="chair${mine ? " mine" : ""}${taken ? " taken" : ""}" id="heroChair" ${taken ? "disabled" : ""}>
    <span class="av">${esc(initials)}</span>
    <span><span class="nm">${esc(h.name)}</span><span class="st">${mine ? "that is you" : taken ? "taken" : "free"}</span></span></button></li>`;
  $("heroChair").onclick = claimHero;

  $("dealerLobby").hidden = !isDealer;
  if (isDealer && !lobbyFilled){
    $("fHero").value = h.name; $("fHouse").value = house().name;
    $("fStakes").value = room.stakes || ""; $("fOpen").checked = !!room.openHand;
    lobbyFilled = true;
  }
}

function faceUp(who){
  if (room.phase === "showdown") return true;
  if (castMode) return false;
  if (isDealer) return true;
  return who === "hero" && (isHero() || !!room.openHand);
}

function renderTable(){
  const h = hero(), o = house(), mine = isHero();
  $("hRound").textContent = room.round;
  $("hCode").textContent = roomCode;
  $("btnLobby").hidden = !isDealer;
  $("btnCast").hidden = !(isDealer || mine);
  $("houseName").textContent = o.name;
  $("heroName").textContent = h.name;
  $("stakes").innerHTML = room.stakes ? `<span>On the table</span> ${esc(room.stakes)}` : "";

  let tl = "";
  if (room.phase === "showdown") tl = "Showdown";
  else if (h.drew) tl = mine ? "Hold your nerve" : "The draw is made";
  else tl = mine ? `<span class="you">Your move</span>` : `${esc(h.name)} is thinking`;
  $("hTurn").innerHTML = tl;

  const hs = hand(h), os = hand(o);
  const hUp = faceUp("hero"), oUp = faceUp("house");
  const pick = mine && room.phase === "play" && !h.drew && !castMode;
  $("heroRow").innerHTML = hUp
    ? hs.map((c, i) => cardHTML(c, (pick ? "pick " : "") + (discard.has(i) ? "sel" : ""), `data-i="${i}"`)).join("")
    : backs();
  $("houseRow").innerHTML = oUp ? os.map(c => cardHTML(c)).join("") : backs();
  $("heroRank").textContent = hUp && hs.length === 5 ? evalHand(hs).name : "";
  $("houseRank").textContent = oUp && os.length === 5 ? evalHand(os).name : "";
  $("heroRow").querySelectorAll(".pick").forEach(el => {
    el.onclick = () => {
      const i = +el.dataset.i;
      if (discard.has(i)) discard.delete(i);
      else if (discard.size < 3) discard.add(i);
      else toast("Three at most.");
      renderTable();
    };
  });
  $("mid").textContent = room.phase === "showdown" ? "Hands open" : "Five-card draw · one draw each";

  renderHeroCard(mine);
  renderDealer();
  $("log").innerHTML = (room.log || []).map(l => `<li>${l}</li>`).join("");
  maybeShowReveal();
}

function renderHeroCard(mine){
  $("heroCard").hidden = !mine;
  if (!mine) return;
  const h = hero();
  let html = "";
  if (room.phase === "play"){
    if (!h.drew){
      html += `<p class="hint">Tap the cards you want to throw back (three at most), then draw. Or stand pat.</p>
        <div class="actions" style="margin-top:12px">
          <button class="btn primary" id="bDraw">${discard.size ? `Draw ${discard.size}` : "Stand pat"}</button>
        </div>`;
    } else {
      html += `<p class="hint">Your draw is made. The dealer will call it.</p>`;
    }
    const spent = h.shadow;
    html += `<button class="shade${shadowArmed ? " armed" : ""}${spent ? " spent" : ""}" id="bShade" ${spent ? "disabled" : ""}>
      <i>◐</i><span>${spent ? "Done. Say nothing." : shadowArmed ? "Tap again to slip it into your hand" : "Your shadow"}</span></button>`;
  } else {
    html += `<p class="hint">The hands are open.</p>`;
  }
  $("heroBody").innerHTML = html;
  const d = $("bDraw"); if (d) d.onclick = heroDraw;
  const s = $("bShade");
  if (s) s.onclick = () => {
    if (!shadowArmed){
      shadowArmed = true; clearTimeout(armTimer);
      armTimer = setTimeout(() => { shadowArmed = false; if (room) renderHeroCard(isHero()); }, 3500);
      renderHeroCard(true);
    } else { clearTimeout(armTimer); useShadow(); }
  };
}

function renderDealer(){
  $("dealerCard").hidden = !isDealer;
  if (!isDealer) return;
  const h = hero(), o = house();
  let html = `<p class="hint">${esc(h.name)} ${h.drew ? "has drawn" : "has not drawn yet"}. `
    + `${hero().shadow ? "<b>The shadow has been used.</b>" : ""}</p>`;
  html += `<div class="actions" style="margin-top:12px">`;
  if (room.phase === "play"){
    html += `<button class="btn primary" id="dCall">Call it</button>`;
    if (!h.shadow) html += `<button class="btn danger" id="dShade">Slip her the Dead Man's Hand</button>`;
  } else {
    html += `<button class="btn primary" id="dNext">Next hand</button>`;
  }
  html += `<button class="btn ghost" id="dLobby">Back to the lobby</button></div>`;
  const sec = room.secret || [];
  if (sec.length) html += `<div class="note mag"><b>Only you can see this</b>${sec.map(s => `<div>${s}</div>`).join("")}</div>`;
  $("dealerBody").innerHTML = html;
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on("dCall", showdown);
  on("dShade", useShadow);
  on("dNext", dealHand);
  on("dLobby", () => { room.phase = "lobby"; save(); });
}

function maybeShowReveal(){
  const r = room.reveal;
  if (!r || room.phase !== "showdown"){ $("reveal").hidden = true; return; }
  if (seenReveal === r.id) return;
  seenReveal = r.id;
  const dead = r.winner === "hero" && r.hero.dead;
  $("revBox").classList.toggle("dead", dead);
  $("revH").textContent = r.winner === "tie" ? "A dead heat"
    : dead ? "The Dead Man's Hand"
    : `${r[r.winner].name} takes it`;
  const row = (p, win) => `<div class="pk-rev-row${win ? " win" : ""}">
    <span class="nm">${esc(p.name)}</span>
    <span class="pk-row sm">${p.hand.map(c => cardHTML(c, "sm" + (p.dead ? " dead" : ""))).join("")}</span>
    <span class="rk">${esc(p.rank)}</span></div>`;
  $("revHands").innerHTML = row(r.hero, r.winner === "hero") + row(r.house, r.winner === "house");
  $("revVerdict").innerHTML = r.winner === "tie" ? "Neither of them blinks."
    : dead ? `Nobody at this table has ever seen a hand like it. <span class="lose">${esc(r.house.name)}</span> folds.`
    : r.winner === "hero" ? `<span class="safe">${esc(r.hero.name)}</span> wins the hand.`
    : `<span class="lose">${esc(r.hero.name)}</span> loses the hand.`;
  $("reveal").hidden = false;
}

/* ---------------- sound ---------------- */

function diff(prev, cur){
  if (!prev || !cur) return;
  const ph = prev.seats[0], ch = cur.seats[0], po = prev.seats[1], co = cur.seats[1];
  if (cur.phase === "play" && (prev.phase !== "play" || (cur.round || 0) > (prev.round || 0))) return sfx.cards();
  if (cur.reveal && (!prev.reveal || prev.reveal.id !== cur.reveal.id)){
    sfx.reveal();
    if (cur.reveal.winner === "house") setTimeout(() => sfx.lose(), 500);
    else if (cur.reveal.hero.dead) setTimeout(() => sfx.over(), 700);
    return;
  }
  if (ch.shadow && !ph.shadow){ if (isHero() || isDealer) sfx.shadow(); return; }
  if (ch.drew && !ph.drew) return sfx.draw();
  if (co.drew && !po.drew) sfx.draw();
}

/* ---------------- connecting ---------------- */

function codeFromURL(){
  const p = new URLSearchParams(location.search).get("t");
  return p ? p.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4) : null;
}
function newCode(){
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from({ length:4 }, () => A[Math.floor(Math.random() * A.length)]).join("");
}
function leaveToMenu(){
  try { localStorage.removeItem(LS.room); localStorage.removeItem(LS.hero); } catch {}
  location.href = "index.html";
}
function attach(code){
  roomCode = code; lastSnap = null;
  roomRef = ref(db, "rooms/" + code);
  try { localStorage.setItem(LS.room, code); } catch {}
  const url = new URL(location.href);
  url.search = "?t=" + code;
  history.replaceState(null, "", url);
  try { isDealer = localStorage.getItem(LS.dealer) === code; } catch {}

  onValue(roomRef, snap => {
    const v = snap.val();
    if (!v){
      $("waitNote").textContent = "That table is not there any more. Back to the menu.";
      show("wait"); setTimeout(leaveToMenu, 1800); return;
    }
    if (v.game !== "poker"){ location.replace("index.html?t=" + code); return; }
    room = v;
    try { diff(lastSnap, v); } catch (e) { console.warn("sound", e); }
    lastSnap = clone(v);
    render();
  }, () => toast("Lost the table. Reload to reconnect."));
}

/* ---------------- wiring ---------------- */

$("btnLeave").onclick = leaveToMenu;
$("btnCopyLink").onclick = async () => {
  const url = new URL(location.href); url.search = "?t=" + roomCode;
  try { await navigator.clipboard.writeText(url.toString()); toast("Link copied. Send it to the table."); }
  catch { toast(url.toString()); }
};
$("btnFreeSeat").onclick = () => {
  const h = hero(); h.claimed = false; delete h.token; save(); toast("The seat is free.");
};
$("btnDeal").onclick = () => {
  const h = hero(), o = house();
  h.name = $("fHero").value.trim() || "Sassafras";
  o.name = $("fHouse").value.trim() || "The House";
  room.stakes = $("fStakes").value.trim();
  room.openHand = $("fOpen").checked;
  dealHand();
};
$("btnLobby").onclick = () => { if (!isDealer) return; room.phase = "lobby"; save(); };
$("btnCast").onclick = () => {
  castMode = !castMode;
  $("btnCast").textContent = castMode ? "Casting" : "Cast";
  toast(castMode ? "The cards are hidden. Safe to share the screen." : "The cards are back.");
  render();
};
$("revClose").onclick = () => { $("reveal").hidden = true; };

const paintSound = () => { $("btnSound").textContent = sfx.label(); };
paintSound();
$("btnSound").onclick = () => { sfx.cycle(); paintSound(); sfx.unlock(); sfx.flip(); };
document.addEventListener("pointerdown", () => sfx.unlock(), { once: true });
sfx.setTheme("poker");

/* ---------------- boot ---------------- */

try {
  db = getDatabase(initializeApp(firebaseConfig));
} catch (e){
  $("waitNote").textContent = "Firebase has not been set up yet. See the README.";
}

if (db){
  const params = new URLSearchParams(location.search);
  if (params.get("new")){
    const code = newCode();
    room = makeRoom();
    try { localStorage.setItem(LS.dealer, code); localStorage.removeItem(LS.hero); } catch {}
    attach(code);
    set(roomRef, clone(room)).catch(() => toast("Could not reach the table. Check your connection."));
    render();
  } else {
    let code = codeFromURL();
    if (!code){ try { code = localStorage.getItem(LS.room); } catch {} }
    if (!code) location.replace("index.html");
    else get(ref(db, "rooms/" + code)).then(snap => {
      if (snap.exists()) attach(code);
      else { $("waitNote").textContent = "No table with that code. Back to the menu."; setTimeout(leaveToMenu, 1800); }
    }).catch(() => { $("waitNote").textContent = "Could not reach the table."; });
  }
}
