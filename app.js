/* ===========================================================
   Liar's Dice at the Dead Man's Hand
   Firebase Realtime Database backs one document per table.
   Every device renders from that document; only the seat you
   claimed shows its own dice.
   =========================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, onValue, set, get }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------------- constants ---------------- */

const TRAITS = [
  { id:"hardread", name:"Hard Read",   skill:"Insight",          desc:"One opponent shows you their dice, and only you." },
  { id:"deft",     name:"Deft Hands",  skill:"Sleight of Hand",  desc:"Change one of your dice to any number." },
  { id:"sly",      name:"Sly Reveal",  skill:"Stealth",          desc:"Show your dice to one opponent." },
  { id:"poker",    name:"Poker Face",  skill:"Deception",        desc:"Beat a challenge with a check instead of dice." },
  { id:"daring",   name:"Daring Dicer",skill:"Dice set",         desc:"Change any number of your dice." },
  { id:"fated",    name:"Fated Luck",  skill:"Any",              desc:"Reroll every die you have left." }
];
const PIPS = {1:[3],2:[1,5],3:[1,3,5],4:[1,2,4,5],5:[1,2,3,4,5],6:[1,2,6,7,4,5]};
const LS = { room:"dmh.room", seat:"dmh.seat", dealer:"dmh.dealer" };

/* ---------------- state ---------------- */

let db = null, roomRef = null, room = null, roomCode = null;
let mySeat = null, isDealer = false, castMode = false;
let draft = { count:1, face:2 }, armed = null, selDie = -1;
let lastRound = -1, seenReveal = null;

/* ---------------- tiny helpers ---------------- */

const $  = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const d6 = () => 1 + Math.floor(Math.random()*6);
const rollN = n => Array.from({length:n}, d6);
const uid = () => Math.random().toString(36).slice(2,9);

function toast(msg){
  const t = $("toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("on"), 2600);
}
function initials(name){
  return name.split(/\s+/).map(w => w[0]).join("").slice(0,2).toUpperCase();
}
function dieHTML(v, cls = ""){
  const pips = (PIPS[v] || []).map(p => `<i class="pip p${p}"></i>`).join("");
  return `<div class="die ${cls}${v === 1 ? " wild" : ""}">${pips}</div>`;
}
function handHTML(dice, cls = ""){ return dice.map(d => dieHTML(d, cls)).join(""); }
function hiddenHTML(n){ return Array.from({length:n}, () => `<div class="die sm hidden"></div>`).join(""); }

/* ---------------- room model ---------------- */

const seatById = id => room ? (room.seats || []).find(s => s.id === id) : null;
const liveSeats = () => room ? (room.seats || []).filter(s => !s.out) : [];
const potCount  = () => liveSeats().reduce((a,s) => a + (s.dice ? s.dice.length : 0), 0);

function nextSeat(fromId){
  const ls = liveSeats();
  const i = ls.findIndex(s => s.id === fromId);
  return ls.length ? ls[(i < 0 ? 0 : (i+1) % ls.length)].id : null;
}
function tallyFace(face){
  let n = 0;
  liveSeats().forEach(s => (s.dice||[]).forEach(d => {
    if (d === face || (d === 1 && face !== 1)) n++;
  }));
  return n;
}
function logAdd(html){
  room.log = room.log || [];
  room.log.push(html);
  if (room.log.length > 70) room.log = room.log.slice(-70);
}
async function save(){
  render();
  if (!roomRef) return;
  try { await set(roomRef, JSON.parse(JSON.stringify(room))); }
  catch (e){ toast("Could not reach the table. Check your connection."); }
}

/* ---------------- game actions ---------------- */

function makeRoom(opponent, names){
  const seats = names.map(n => ({
    id:uid(), name:n, kind:"pc", dice:[], count:5, out:false, used:0, claimed:false
  }));
  if (opponent === "king"){
    seats.push({ id:uid(), name:"Vander Boone", kind:"npc", dice:[], count:5, out:false, used:0, claimed:true });
    seats.push({ id:uid(), name:"Lyla Webb",    kind:"npc", dice:[], count:5, out:false, used:0, claimed:true });
  } else {
    seats.push({ id:uid(), name:"Mister Crossroads", kind:"npc",
                 dice:[], count:5 + names.length, out:false, used:0, claimed:true });
  }
  return {
    v:2, opponent, phase:"lobby", round:0,
    seats, turn:seats[0].id, opener:seats[0].id,
    bid:null, reveal:null, reveals:[], pokerFace:null, log:[], winner:null
  };
}

function dealRound(){
  room.seats.forEach(s => { if (!s.out) s.dice = rollN(s.count); });
  room.bid = null; room.reveal = null; room.reveals = []; room.pokerFace = null;
  room.phase = "bidding";
  room.round = (room.round || 0) + 1;
  room.turn = room.opener;
  logAdd(`<b>Round ${room.round}</b> &mdash; ${potCount()} dice on the table.`);
  selDie = -1; armed = null;
  save();
}

function placeBid(count, face){
  const s = seatById(room.turn); if (!s) return;
  room.bid = { count, face, by:s.id };
  logAdd(`<b>${esc(s.name)}</b> bids <span class="hi">${count} &times; ${face}</span>`);
  room.turn = nextSeat(s.id);
  draft = { count, face };
  save();
}

function doChallenge(){
  const challenger = seatById(room.turn);
  const bidder = seatById(room.bid.by);
  const got = tallyFace(room.bid.face);
  const overbid = got < room.bid.count;
  const loser = overbid ? bidder : challenger;
  room.reveal = {
    id: uid(),
    challenger: challenger.id, bidder: bidder.id,
    face: room.bid.face, need: room.bid.count, got,
    loser: loser.id, overbid,
    hands: room.seats.filter(s => !s.out).map(s => ({ id:s.id, name:s.name, dice:(s.dice||[]).slice() }))
  };
  room.phase = "reveal";
  logAdd(`<b>${esc(challenger.name)}</b> challenges &mdash; there ${got === 1 ? "was" : "were"} <b>${got}</b> &times; ${room.bid.face}. ` +
         `<span class="${overbid ? "lo" : "hi"}">${esc(loser.name)} loses a die.</span>`);
  save();
}

function nextRound(){
  const loser = seatById(room.reveal.loser);
  loser.count -= 1;
  if (loser.count <= 0){
    loser.out = true; loser.dice = [];
    logAdd(`<b>${esc(loser.name)}</b> is out.`);
  }
  const left = liveSeats();
  if (left.length <= 1){
    room.phase = "over";
    room.winner = left.length ? left[0].id : null;
    if (room.winner) logAdd(`<b>${esc(seatById(room.winner).name)}</b> takes the table.`);
    room.reveal = null;
    return save();
  }
  room.opener = loser.out ? nextSeat(loser.id) : loser.id;
  room.reveal = null;
  dealRound();
}

/* ---------------- traits ---------------- */

function useTrait(t){
  const s = mySeat && seatById(mySeat);
  if (!s || s.used >= 3 || s.out) return;

  if (t.id === "fated"){
    s.dice = rollN(s.dice.length); s.used++;
    logAdd(`<b>${esc(s.name)}</b> calls <span class="hi">Fated Luck</span>.`);
    return save();
  }
  if (t.id === "poker"){
    room.pokerFace = { by:s.id }; s.used++;
    logAdd(`<b>${esc(s.name)}</b> plays <span class="hi">Poker Face</span>. The dealer resolves the check.`);
    return save();
  }
  armed = (armed === t.id) ? null : t.id;
  selDie = -1;
  if (armed === "hardread") toast("Tap the seat you want to read.");
  if (armed === "sly")      toast("Tap the seat you want to show.");
  if (armed === "deft")     toast("Tap one of your dice, then pick its new face.");
  if (armed === "daring")   toast("Tap any of your dice to change them, then Done.");
  render();
}

function trainTraitOn(targetId){
  const me = seatById(mySeat), target = seatById(targetId);
  if (!me || !target || target.id === me.id) return;
  room.reveals = room.reveals || [];
  if (armed === "hardread"){
    room.reveals.push({ to:me.id, from:target.id, dice:(target.dice||[]).slice(), round:room.round });
    logAdd(`<b>${esc(me.name)}</b> takes a <span class="hi">Hard Read</span> on ${esc(target.name)}.`);
  } else if (armed === "sly"){
    room.reveals.push({ to:target.id, from:me.id, dice:(me.dice||[]).slice(), round:room.round });
    logAdd(`<b>${esc(me.name)}</b> makes a <span class="hi">Sly Reveal</span> to ${esc(target.name)}.`);
  }
  me.used++; armed = null; save();
}

function setDie(i, val){
  const me = seatById(mySeat); if (!me) return;
  me.dice[i] = val;
  if (armed === "deft"){
    me.used++; armed = null;
    logAdd(`<b>${esc(me.name)}</b> uses <span class="hi">Deft Hands</span>.`);
  }
  selDie = -1; save();
}

/* ---------------- views ---------------- */

function show(view){
  ["landing","lobby","table"].forEach(v => {
    $("view-" + v).hidden = (v !== view);
  });
}

function render(){
  if (!room){ show("landing"); return; }
  if (room.phase === "lobby"){ show("lobby"); renderLobby(); return; }
  show("table"); renderTable();
}

/* ---- lobby ---- */
function renderLobby(){
  $("lobbyCode").textContent = roomCode;
  $("lobbyDealerCard").hidden = !isDealer;

  const chairs = $("lobbyChairs");
  chairs.innerHTML = room.seats.map(s => {
    const mine = s.id === mySeat;
    const cls = ["chair", s.kind === "npc" ? "house" : "", s.claimed && !mine ? "taken" : "", mine ? "mine" : ""].join(" ");
    const status = s.kind === "npc" ? "the house" : (mine ? "that is you" : (s.claimed ? "taken" : "free"));
    return `<li><button class="${cls}" data-sit="${s.id}"
      ${(s.kind === "npc" || (s.claimed && !mine)) ? "disabled" : ""}>
      <span class="av${s.kind === "npc" ? " npc" : ""}">${esc(initials(s.name))}</span>
      <span><span class="nm">${esc(s.name)}</span><span class="st">${status}</span></span>
    </button></li>`;
  }).join("");
  chairs.querySelectorAll("[data-sit]").forEach(b => {
    b.onclick = () => claimSeat(b.dataset.sit);
  });

  $("lobbyHint").textContent = mySeat
    ? "You are seated. The dealer starts when everyone is in."
    : "Tap an empty chair to sit down.";

  if (isDealer){
    const names = room.seats.filter(s => s.kind === "pc").map(s => s.name).join("\n");
    if ($("lobbyNames") !== document.activeElement) $("lobbyNames").value = names;
    $("lobbyOpp").value = room.opponent;
    updatePool();
  }
}
function updatePool(){
  const n = $("lobbyNames").value.split("\n").map(s => s.trim()).filter(Boolean).length;
  $("lobbyPool").textContent = $("lobbyOpp").value === "sinner"
    ? `Mister Crossroads opens on ${5 + n} dice: five, plus one for every character who sits down.`
    : "Vander and Lyla take five dice each, and they signal to each other under the table.";
}

/* ---- table ---- */
function renderTable(){
  const me = mySeat && seatById(mySeat);
  $("hRound").textContent = room.round;
  $("hCode").textContent = roomCode;
  $("potN").textContent = potCount();

  // turn line
  const turn = seatById(room.turn);
  let tl = "";
  if (room.phase === "over"){
    tl = room.winner ? `<span class="you">${esc(seatById(room.winner).name)}</span> takes the table` : "Nobody left standing";
  } else if (room.phase === "reveal"){
    tl = "Hands on the table";
  } else if (turn){
    tl = (turn.id === mySeat) ? `<span class="you">Your move</span>` : `Waiting on ${esc(turn.name)}`;
  }
  $("hTurn").innerHTML = tl;

  // bid card
  if (room.bid){
    $("bidV").textContent = `${room.bid.count} × ${room.bid.face}`;
    $("bidV").classList.remove("none");
    const b = seatById(room.bid.by);
    $("bidBy").textContent = b ? `bid by ${b.name}` : "";
  } else {
    $("bidV").textContent = "—"; $("bidV").classList.add("none");
    $("bidBy").textContent = "nobody has opened";
  }

  renderSeats();
  renderHand(me);
  renderTraits(me);
  renderDealer();
  renderLog();
  maybeShowReveal();
}

function renderSeats(){
  const openHands = room.phase === "over";
  $("seats").innerHTML = room.seats.map(s => {
    const mine = s.id === mySeat && !castMode;
    const cls = ["seat", s.out ? "out" : "", (room.turn === s.id && room.phase === "bidding") ? "turn" : "", mine ? "mine" : ""].join(" ");
    const showReal = (mine || openHands || (isDealer && !castMode)) && (s.dice||[]).length;
    const dice = showReal ? handHTML(s.dice, "sm")
               : ((s.dice||[]).length ? hiddenHTML(s.dice.length) : "");
    return `<li class="${cls}" data-seat="${s.id}">
      <span class="av${s.kind === "npc" ? " npc" : ""}">${esc(initials(s.name))}</span>
      <span><span class="nm">${esc(s.name)}</span>
        <span class="st">${s.out ? "out" : (s.kind === "npc" ? "the house" : "player")} · ${3 - s.used} trait${3 - s.used === 1 ? "" : "s"}</span>
        ${dice ? `<span class="mini">${dice}</span>` : ""}</span>
      <span class="cnt">${s.count}<small>dice</small></span>
    </li>`;
  }).join("");

  if (armed === "hardread" || armed === "sly"){
    $("seats").querySelectorAll("[data-seat]").forEach(node => {
      if (node.dataset.seat === mySeat) return;
      node.style.cursor = "pointer";
      node.style.borderColor = "var(--green)";
      node.onclick = () => trainTraitOn(node.dataset.seat);
    });
  }
}

function renderHand(me){
  const dice = $("dice"), extra = $("handExtra"), ctl = $("controls");

  if (!me){
    $("handWho").textContent = "You are watching";
    $("handMeta").textContent = "";
    dice.innerHTML = hiddenHTML(5);
    extra.innerHTML = `<p class="hint" style="margin-top:12px">You have no seat at this table.</p>`;
    ctl.innerHTML = "";
    return;
  }

  $("handWho").textContent = castMode ? "Hand hidden for casting" : me.name;
  $("handMeta").textContent = me.out ? "out of the game"
    : `${me.dice.length} ${me.dice.length === 1 ? "die" : "dice"} · ${3 - me.used} trait${3 - me.used === 1 ? "" : "s"} left`;

  if (castMode){ dice.innerHTML = hiddenHTML(me.dice.length || 5); }
  else if (me.out){ dice.innerHTML = ""; }
  else {
    const fresh = room.round !== lastRound;
    const clickable = (armed === "deft" || armed === "daring") ? "clickable" : "";
    dice.innerHTML = me.dice.map((d,i) =>
      dieHTML(d, `${clickable}${selDie === i ? " sel" : ""}${fresh ? " roll" : ""}`)
        .replace("<div class=", `<div data-i="${i}" tabindex="${clickable ? 0 : -1}" class=`)
    ).join("");
    if (fresh){
      [...dice.children].forEach((el,i) => el.style.animationDelay = (i * 70) + "ms");
      lastRound = room.round;
    }
    dice.querySelectorAll(".die.clickable").forEach(el => {
      el.onclick = () => { selDie = +el.dataset.i; render(); };
      el.onkeydown = e => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); el.click(); } };
    });
  }

  // face picker + private reveals
  let ex = "";
  if (selDie >= 0 && !castMode){
    ex += `<div class="note"><b>New face</b><div class="faces" style="margin-top:6px">` +
      [1,2,3,4,5,6].map(v => `<button data-new="${v}">${dieHTML(v,"sm")}</button>`).join("") +
      `</div></div>`;
  }
  if (armed === "daring") ex += `<div class="actions" style="margin-top:12px"><button class="btn primary" id="doneDaring">Done</button></div>`;

  (room.reveals || []).filter(r => r.to === me.id).forEach(r => {
    const from = seatById(r.from);
    ex += `<div class="note green"><b>${esc(from ? from.name : "?")}, shown to you alone</b>
      <span class="mini" style="margin-top:6px">${handHTML(r.dice,"sm")}</span></div>`;
  });
  extra.innerHTML = ex;

  extra.querySelectorAll("[data-new]").forEach(b => {
    b.onclick = () => setDie(selDie, +b.dataset.new);
  });
  const dd = $("doneDaring");
  if (dd) dd.onclick = () => {
    const s = seatById(mySeat); s.used++;
    logAdd(`<b>${esc(s.name)}</b> uses <span class="hi">Daring Dicer</span>.`);
    armed = null; selDie = -1; save();
  };

  // controls
  ctl.innerHTML = buildControls(me);
  wireControls();
}

function buildControls(me){
  if (room.phase === "over"){
    return isDealer ? `<div class="actions"><button class="btn primary" id="cNew">New table</button></div>` : "";
  }
  if (room.phase === "reveal"){
    return isDealer ? `<div class="actions"><button class="btn primary" id="cNext">Next round</button></div>`
                    : `<p class="hint">Waiting on the dealer.</p>`;
  }
  if (me.out) return `<p class="hint">You are out. Watch it play out.</p>`;
  if (room.turn !== me.id){
    const t = seatById(room.turn);
    return `<p class="hint">Waiting on <b style="color:var(--bone)">${esc(t ? t.name : "?")}</b>.</p>` + dealerStrip();
  }
  let h = `<div class="bidrow">
    <div class="field" style="margin:0">
      <label>How many</label>
      <div class="stepper">
        <button id="cMinus" aria-label="Fewer">−</button>
        <div class="n">${draft.count}</div>
        <button id="cPlus" aria-label="More">+</button>
      </div>
    </div>
    <div class="field" style="margin:0">
      <label>Showing</label>
      <div class="faces">` +
        [1,2,3,4,5,6].map(f => `<button class="${draft.face === f ? "on" : ""}" data-face="${f}">${dieHTML(f,"sm")}</button>`).join("") +
      `</div>
    </div>
  </div>
  <div class="actions">
    <button class="btn primary" id="cBid">Bid ${draft.count} × ${draft.face}</button>
    ${room.bid ? `<button class="btn danger" id="cChal">Challenge</button>` : ""}
  </div>`;
  if (room.bid) h += `<p class="hint">Raise the count, the face, or both. Ones are wild.</p>`;
  return h + dealerStrip();
}
function dealerStrip(){
  if (!isDealer) return "";
  return `<div class="actions" style="border-top:1px solid var(--line-soft);padding-top:12px">
    <button class="btn ghost sm" id="cRedeal">Redeal round</button>
    <button class="btn ghost sm" id="cNewD">New table</button></div>`;
}

function wireControls(){
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on("cMinus", () => { draft.count = Math.max(1, draft.count - 1); render(); });
  on("cPlus",  () => { draft.count = Math.min(potCount(), draft.count + 1); render(); });
  document.querySelectorAll("[data-face]").forEach(b => {
    b.onclick = () => { draft.face = +b.dataset.face; render(); };
  });
  on("cBid", () => {
    if (room.bid){
      const ok = draft.count > room.bid.count ||
                 (draft.count === room.bid.count && draft.face > room.bid.face);
      if (!ok) return toast("That does not raise it. Go higher on the count, the face, or both.");
    }
    placeBid(draft.count, draft.face);
  });
  on("cChal", doChallenge);
  on("cNext", nextRound);
  on("cRedeal", () => {
    room.seats.forEach(s => { if (!s.out) s.dice = rollN(s.count); });
    logAdd("The dealer redeals the round."); lastRound = -1; save();
  });
  on("cNew",  () => { room.phase = "lobby"; room.round = 0; save(); });
  on("cNewD", () => { room.phase = "lobby"; room.round = 0; save(); });
}

function renderTraits(me){
  const left = me ? (3 - me.used) : 3;
  $("traitsLeft").textContent = left === 1 ? "1 use" : left + " uses";
  const wrap = $("traits");
  if (!me || me.out){
    wrap.innerHTML = `<p class="hint">No traits without a seat.</p>`; return;
  }
  wrap.innerHTML = TRAITS.map(t => {
    const spent = me.used >= 3;
    return `<button class="trait ${armed === t.id ? "armed" : ""}" data-trait="${t.id}" ${spent ? "disabled" : ""}>
      <b>${t.name}</b><span>${t.skill} · ${t.desc}</span></button>`;
  }).join("");
  wrap.querySelectorAll("[data-trait]").forEach(b => {
    b.onclick = () => useTrait(TRAITS.find(t => t.id === b.dataset.trait));
  });
}

function renderDealer(){
  $("dealerCard").hidden = !isDealer;
  if (!isDealer) return;
  let h = `<div class="scroll"><table class="tbl"><thead><tr>
    <th>Seat</th><th>Hand</th><th>Traits</th><th>Whisper</th></tr></thead><tbody>` +
    room.seats.map(s => `<tr>
      <td>${esc(s.name)}${s.out ? " <span class='st'>out</span>" : ""}</td>
      <td><span class="mini">${(s.dice||[]).length ? handHTML(s.dice,"sm") : "—"}</span></td>
      <td class="n">${3 - s.used}</td>
      <td>${(s.dice||[]).length && !s.out ? `<button class="btn ghost sm" data-wh="${s.id}">Copy</button>` : "—"}</td>
    </tr>`).join("") + `</tbody></table></div>`;

  h += `<div class="scroll" style="margin-top:12px"><table class="tbl"><thead><tr><th>Face</th>` +
    [1,2,3,4,5,6].map(f => `<th style="text-align:center">${f}</th>`).join("") +
    `</tr></thead><tbody><tr><td>On the table, ones wild</td>` +
    [1,2,3,4,5,6].map(f => `<td class="n">${tallyFace(f)}</td>`).join("") +
    `</tr></tbody></table></div>`;

  if (room.pokerFace){
    const pf = seatById(room.pokerFace.by);
    h += `<div class="note mag"><b>Poker Face — ${esc(pf ? pf.name : "?")}</b>
      Charisma (Deception) against DC 15 or the challenger's Wisdom score, whichever is higher.
      On a success the challenge is withdrawn.
      <div class="actions" style="margin-top:9px">
        <button class="btn primary sm" id="pfWin">It worked</button>
        <button class="btn ghost sm" id="pfLose">It failed</button></div></div>`;
  }
  h += room.opponent === "sinner"
    ? `<div class="note mag"><b>Overweening Pride</b>Any creature can spend a Bonus Action to insult his record
        as a pirate captain. DC 15 Wisdom or he takes 10 Psychic and has Disadvantage against everyone but
        the speaker. The moment he is eliminated he roars, flips the table and forfeits.</div>`
    : `<div class="note green"><b>You know both their hands</b>Vander and Lyla signal each other under the table.
        Play them as a pair quietly working together, and let it show once or twice.</div>`;

  $("dealerBody").innerHTML = h;

  const whisper = s => `${s.name} — your hand: ${s.dice.join("  ")}   (ones are wild). ` +
    `${3 - s.used} trait use${3 - s.used === 1 ? "" : "s"} left.`;
  $("dealerBody").querySelectorAll("[data-wh]").forEach(b => {
    b.onclick = async () => {
      const s = seatById(b.dataset.wh);
      try { await navigator.clipboard.writeText(whisper(s)); toast(`Copied ${s.name}'s hand.`); }
      catch { toast(whisper(s)); }
    };
  });
  const pw = $("pfWin"), pl = $("pfLose");
  if (pw) pw.onclick = () => {
    room.pokerFace = null; room.reveal = null; room.phase = "bidding";
    logAdd(`The challenge is <span class="hi">withdrawn</span>.`); save();
  };
  if (pl) pl.onclick = () => {
    room.pokerFace = null; logAdd(`Poker Face <span class="lo">fails</span>.`); save();
  };
}

function renderLog(){
  $("log").innerHTML = (room.log || []).map(l => `<li>${l}</li>`).join("");
}

/* ---- the reveal moment ---- */
function maybeShowReveal(){
  const r = room.reveal;
  if (!r || room.phase !== "reveal"){ $("reveal").hidden = true; return; }
  if (seenReveal === r.id) return;
  seenReveal = r.id;

  const bidder = seatById(r.bidder), challenger = seatById(r.challenger), loser = seatById(r.loser);
  $("revEyebrow").textContent = "Hands on the table";
  $("revH").innerHTML = `${esc(challenger.name)} calls ${esc(bidder.name)} on
    <span style="color:var(--green)">${r.need} × ${r.face}</span>`;

  $("revHands").innerHTML = r.hands.map(h => `<div class="rev-row">
      <span class="nm">${esc(h.name)}</span>
      <span class="mini">${h.dice.map(d =>
        dieHTML(d, "sm" + ((d === r.face || (d === 1 && r.face !== 1)) ? " match" : ""))).join("")}</span>
    </div>`).join("");

  $("revLabel").innerHTML = `showing ${r.face}${r.face === 1 ? "" : "s, ones wild"}`;
  $("revVerdict").innerHTML = r.overbid
    ? `The bid was too high. <span class="lose">${esc(loser.name)}</span> loses a die.`
    : `The bid was good. <span class="lose">${esc(loser.name)}</span> loses a die for calling it.`;
  $("reveal").hidden = false;

  // count up to the tally
  const el = $("revCount"); let n = 0; el.textContent = "0";
  const step = () => {
    if (n >= r.got) return;
    n++; el.textContent = n;
    setTimeout(step, Math.max(90, 420 / Math.max(1, r.got)));
  };
  setTimeout(step, 520);
}
$("revClose").onclick = () => { $("reveal").hidden = true; };

/* ---------------- room lifecycle ---------------- */

function codeFromURL(){
  const p = new URLSearchParams(location.search).get("t");
  return p ? p.toUpperCase().replace(/[^A-Z]/g,"").slice(0,4) : null;
}
function newCode(){
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from({length:4}, () => A[Math.floor(Math.random()*A.length)]).join("");
}
function attach(code){
  roomCode = code;
  roomRef = ref(db, "rooms/" + code);
  try { localStorage.setItem(LS.room, code); } catch {}
  const url = new URL(location.href);
  url.searchParams.set("t", code);
  history.replaceState(null, "", url);

  onValue(roomRef, snap => {
    const v = snap.val();
    if (!v){ room = null; show("landing"); toast("That table is not there any more."); return; }
    room = v;
    if (mySeat && !seatById(mySeat)) mySeat = null;
    render();
  }, err => toast("Lost the table. Reload to reconnect."));
}

async function claimSeat(seatId){
  const s = seatById(seatId);
  if (!s || (s.claimed && s.id !== mySeat)) return;
  if (mySeat){ const old = seatById(mySeat); if (old) old.claimed = false; }
  s.claimed = true;
  mySeat = s.id;
  try { localStorage.setItem(LS.seat, mySeat); } catch {}
  await save();
  toast(`You are ${s.name}.`);
}

/* ---------------- wiring ---------------- */

$("btnCreate").onclick = async () => {
  const code = newCode();
  room = makeRoom("king", ["Sassafras","Sister Maple","Fizzwick","Bird"]);
  isDealer = true; mySeat = null;
  try { localStorage.setItem(LS.dealer, code); localStorage.removeItem(LS.seat); } catch {}
  attach(code);
  await save();
};
$("btnJoin").onclick = () => {
  const code = $("joinCode").value.toUpperCase().replace(/[^A-Z]/g,"").slice(0,4);
  if (code.length !== 4) return toast("Four letters, as the dealer gave them to you.");
  attach(code);
};
$("joinCode").addEventListener("keydown", e => { if (e.key === "Enter") $("btnJoin").click(); });

$("btnCopyLink").onclick = async () => {
  const url = new URL(location.href); url.searchParams.set("t", roomCode);
  try { await navigator.clipboard.writeText(url.toString()); toast("Link copied. Send it to the table."); }
  catch { toast(url.toString()); }
};
$("btnLeaveLobby").onclick = () => {
  try { localStorage.removeItem(LS.room); localStorage.removeItem(LS.seat); } catch {}
  room = null; roomRef = null; mySeat = null; isDealer = false;
  history.replaceState(null, "", location.pathname);
  show("landing");
};
$("btnSeatSwap").onclick = () => { room.phase = "lobby"; save(); };
$("btnCast").onclick = () => {
  castMode = !castMode;
  $("btnCast").textContent = castMode ? "Casting" : "Cast";
  toast(castMode ? "Your hand is hidden. Safe to share the screen." : "Your hand is back.");
  render();
};
$("lobbyOpp").onchange = updatePool;
$("lobbyNames").oninput = updatePool;
$("btnDeal").onclick = () => {
  const names = $("lobbyNames").value.split("\n").map(s => s.trim()).filter(Boolean);
  if (!names.length) return toast("Put at least one name in.");
  const keep = {};
  room.seats.forEach(s => { if (s.claimed && s.kind === "pc") keep[s.name] = s.id; });
  const next = makeRoom($("lobbyOpp").value, names);
  next.seats.forEach(s => {
    if (s.kind === "pc" && keep[s.name]){ s.id = keep[s.name]; s.claimed = true; }
  });
  next.turn = next.seats[0].id; next.opener = next.seats[0].id;
  next.log = room.log || [];
  room = next;
  lastRound = -1;
  dealRound();
};

/* ---------------- boot ---------------- */

try {
  db = getDatabase(initializeApp(firebaseConfig));
} catch (e){
  document.querySelector(".landing").innerHTML =
    `<h1 class="logo">Not connected</h1>
     <p class="tagline">Firebase has not been set up yet. Put your project's config into
     <code>firebase-config.js</code> and reload. The README has the five steps.</p>`;
}

if (db){
  try {
    mySeat  = localStorage.getItem(LS.seat) || null;
  } catch {}
  const code = codeFromURL() || (() => { try { return localStorage.getItem(LS.room); } catch { return null; } })();
  if (code){
    try { isDealer = localStorage.getItem(LS.dealer) === code; } catch {}
    // only attach if the table actually exists
    get(ref(db, "rooms/" + code)).then(snap => {
      if (snap.exists()) attach(code);
      else { show("landing"); if (codeFromURL()) toast("No table with that code."); }
    }).catch(() => show("landing"));
  } else {
    show("landing");
  }
}
