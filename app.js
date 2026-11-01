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
/* Cheats are granted per character sheet, once per proficiency (twice with
   expertise). A name with no entry here gets none. */
const PROFICIENCIES = {
  "Sassafras":    { hardread:1, deft:2, sly:1, poker:2, daring:1, fated:1 },
  "Sister Maple": { hardread:1 },
  "Fizzwick":     { poker:1, deft:1 },
  "Ryn":          { hardread:1, poker:1 }
};
const PIPS = {1:[3],2:[1,5],3:[1,3,5],4:[1,2,4,5],5:[1,2,3,4,5],6:[1,2,6,7,4,5]};
const LS = { room:"dmh.room", seat:"dmh.seat", dealer:"dmh.dealer" };

/* ---------------- state ---------------- */

let db = null, roomRef = null, room = null, roomCode = null;
let mySeat = null, isDealer = false, castMode = false;
let draft = { count:1, face:2 }, armed = null, selDie = -1;
let lastRound = -1, seenReveal = null, lastSnap = null;

/* ---------------- sound ---------------- */
/* Everything is made from filtered noise, so it sounds like a room rather than
   a machine: dice on timber, knuckles on the rail, cloth, creaking boards, water.
   There are no tones to ping. Quiet on purpose; the dealer will have music on. */

const sfx = (() => {
  const MODES = ["all", "dice", "off"];
  const LABEL = { all:"Sound: all", dice:"Sound: dice", off:"Sound: off" };
  const FEEL = {
    plain:  { knock:150, tick:[1500, 4600] },
    king:   { knock:112, tick:[900, 3300] },
    sinner: { knock:92,  tick:[1000, 3700] }
  };
  let ctx = null, bus = null, wet = null, noiseBuf = null;
  let mode = "all", theme = "sinner", ambTimer = null;
  try {
    const saved = localStorage.getItem("dmh.sound");
    if (MODES.includes(saved)) mode = saved;
    else if (localStorage.getItem("dmh.mute") === "1") mode = "off";
  } catch {}

  const rand = (a, b) => a + Math.random() * (b - a);
  const feel = () => FEEL[theme] || FEEL.plain;
  const T = s => ctx.currentTime + s;

  function build(){
    const drive = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++){ const x = i / 512 - 1; curve[i] = Math.tanh(x * 1.7) / Math.tanh(1.7); }
    drive.curve = curve;
    const tone = ctx.createBiquadFilter(); tone.type = "lowpass"; tone.frequency.value = 5200; tone.Q.value = 0.4;
    const level = ctx.createGain(); level.gain.value = 0.34;
    bus = ctx.createGain();
    bus.connect(drive); drive.connect(tone); tone.connect(level); level.connect(ctx.destination);

    const len = Math.floor(ctx.sampleRate * 0.9), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++){
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.4);
    }
    const conv = ctx.createConvolver(); conv.buffer = ir;
    wet = ctx.createGain(); wet.gain.value = 0.32;
    wet.connect(conv); conv.connect(drive);

    const n = Math.floor(ctx.sampleRate * 4);
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }

  function ready(){
    if (mode === "off") return false;
    if (!ctx){
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      build();
    }
    if (ctx.state === "suspended"){ const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); }
    if (!ambTimer) scheduleAmb();
    return true;
  }

  /* ---- building blocks ---- */
  let lane = 1;
  function out(node, w = 0.3){
    const l = ctx.createGain(); l.gain.value = lane;
    node.connect(l); l.connect(bus);
    if (w){ const s = ctx.createGain(); s.gain.value = w; l.connect(s); s.connect(wet); }
  }
  function nsrc(t, dur){
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    s.start(t, Math.random() * (noiseBuf.duration - dur - 0.1)); s.stop(t + dur + 0.05);
    return s;
  }
  function burst(g, t, attack, peak, dur){
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  function click(s, f, q, dur, peak, w = 0.35){
    const t = T(s), src = nsrc(t, dur), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    bp.type = "bandpass"; bp.frequency.value = f; bp.Q.value = q;
    burst(g, t, 0.002, peak, dur);
    src.connect(bp); bp.connect(g); out(g, w);
  }
  function thud(s, f, dur, peak, w = 0.5){
    const t = T(s), o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(f * 1.7, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.04);
    o.frequency.exponentialRampToValueAtTime(f * 0.55, t + dur);
    burst(g, t, 0.003, peak, dur);
    o.connect(g); out(g, w); o.start(t); o.stop(t + dur + 0.05);
    const src = nsrc(t, dur * 0.5), lp = ctx.createBiquadFilter(), g2 = ctx.createGain();
    lp.type = "lowpass"; lp.frequency.value = f * 6; lp.Q.value = 0.7;
    burst(g2, t, 0.002, peak * 0.9, dur * 0.45);
    src.connect(lp); lp.connect(g2); out(g2, w);
  }
  function rustle(s, dur, peak, lo, hi, w = 0.3){
    const t = T(s), src = nsrc(t, dur), hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    hp.type = "highpass"; hp.frequency.value = lo; lp.type = "lowpass"; lp.frequency.value = hi;
    const n = Math.max(8, Math.floor(dur * 55)), c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = peak * Math.sin(Math.PI * i / (n - 1)) * Math.pow(Math.random(), 1.6);
    g.gain.setValueCurveAtTime(c, t, dur);
    src.connect(hp); hp.connect(lp); lp.connect(g); out(g, w);
  }
  function swell(s, dur, f0, f1, peak, trem = 0, rate = 9, w = 0.6){
    const t = T(s), src = nsrc(t, dur), lp = ctx.createBiquadFilter(), g = ctx.createGain();
    lp.type = "lowpass"; lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(f0, t); lp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + dur * 0.22);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp); lp.connect(g);
    if (trem){
      const lfo = ctx.createOscillator(), depth = ctx.createGain(), tg = ctx.createGain();
      tg.gain.value = 1 - trem / 2;
      lfo.frequency.value = rate; depth.gain.value = trem / 2;
      lfo.connect(depth); depth.connect(tg.gain);
      g.connect(tg); out(tg, w);
      lfo.start(t); lfo.stop(t + dur + 0.05);
    } else out(g, w);
  }
  function creak(s, dur, f0, f1, peak, w = 0.5){
    const t = T(s), src = nsrc(t, dur), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    bp.type = "bandpass"; bp.Q.value = 7;
    bp.frequency.setValueAtTime(f0, t);
    for (let i = 1; i <= 6; i++) bp.frequency.linearRampToValueAtTime(f0 + (f1 - f0) * (i / 6) * rand(0.7, 1.3), t + dur * i / 6);
    const n = 24, c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = peak * Math.sin(Math.PI * i / (n - 1)) * rand(0.4, 1);
    g.gain.setValueCurveAtTime(c, t, dur);
    src.connect(bp); bp.connect(g); out(g, w);
  }
  function drip(s, peak){
    const t = T(s), src = nsrc(t, 0.12), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    bp.type = "bandpass"; bp.Q.value = 5;
    bp.frequency.setValueAtTime(rand(450, 700), t);
    bp.frequency.exponentialRampToValueAtTime(rand(1300, 2000), t + 0.07);
    burst(g, t, 0.003, peak, 0.1);
    src.connect(bp); bp.connect(g); out(g, 0.9);
  }
  function splash(s, peak){
    click(s, rand(700, 1200), 0.7, rand(0.25, 0.4), peak, 0.7);
    swell(s, 0.5, 700, 150, peak * 0.6, 0, 9, 0.5);
  }

  /* ---- the sounds ---- */
  const V = {
    deal(){
      const k = feel(), n = 24;
      const ts = Array.from({ length:n }, () => Math.pow(Math.random(), 1.8) * 1.1).sort((a, b) => a - b);
      ts.forEach((t, i) => {
        const fade = 1 - t / 1.4;
        click(0.02 + t, rand(k.tick[0], k.tick[1]), rand(2, 5), rand(0.025, 0.06), 1.1 * fade + 0.15);
        if (i % 3 === 0) thud(0.02 + t, rand(k.knock * 0.9, k.knock * 1.6), 0.1, 0.5 * fade + 0.08, 0.3);
      });
      click(1.3, 1300, 3, 0.04, 0.4); click(1.42, 1000, 3, 0.03, 0.25);
    },
    bid(){
      const k = feel();
      thud(0, k.knock, 0.18, 0.8, 0.4); click(0, 1500, 2.5, 0.05, 0.7); rustle(0.03, 0.2, 0.25, 2500, 7000);
    },
    turn(){
      const k = feel();
      thud(0, k.knock * 1.3, 0.1, 0.22, 0.3); thud(0.2, k.knock * 1.15, 0.1, 0.18, 0.3); rustle(0.05, 0.25, 0.08, 3000, 8000);
    },
    reveal(){
      const k = feel();
      thud(0, k.knock * 0.55, 0.6, 1.0, 0.7);
      swell(0, 1.0, 1000, 140, 0.9, 0, 9, 0.7);
      for (let i = 0; i < 9; i++) click(0.1 + Math.random() * 0.6, rand(k.tick[0], k.tick[1]), rand(2, 5), rand(0.03, 0.07), 0.6, 0.4);
    },
    lose(){
      const k = feel(), gator = theme === "sinner";
      swell(0, 1.2, 320, 70, 1.0, gator ? 0.7 : 0.25, gator ? 13 : 6, 0.7);
      thud(0.05, k.knock * 0.5, 0.5, 0.8, 0.6);
    },
    trait(){
      rustle(0, 0.22, 0.6, 1800, 8000, 0.2); rustle(0.17, 0.22, 0.55, 2500, 9000, 0.2); click(0.42, 2600, 4, 0.03, 0.25);
    },
    over(){
      const k = feel();
      thud(0, k.knock * 0.45, 1.3, 1.0, 0.9);
      swell(0.05, 2.6, 600, 55, 0.9, theme === "sinner" ? 0.6 : 0.2, 8, 0.9);
      creak(0.5, 1.2, 170, 95, 0.5);
    }
  };

  /* ---- atmosphere: the odd noise from the room, never on a beat ---- */
  const AMB = {
    king: [
      () => creak(0, rand(0.9, 1.6), rand(150, 260), rand(90, 170), 3.2),
      () => drip(0, 1.6),
      () => rustle(0, 0.5, 0.35, 2500, 7000),
      () => swell(0, 2.2, 260, 70, 1.0, 0, 9, 0.9)
    ],
    sinner: [
      () => splash(0, 0.6),
      () => { drip(0, 1.4); drip(0.17, 1.1); drip(0.3, 1.0); },
      () => swell(0, 2.0, 200, 60, 1.5, 0.8, 11, 0.9),
      () => rustle(0, 0.9, 0.45, 700, 3500, 0.5)
    ]
  };
  function ambient(){
    const pool = AMB[theme];
    if (!pool) return;
    lane = 0.5;
    try { pool[Math.floor(Math.random() * pool.length)](); } finally { lane = 1; }
  }
  function scheduleAmb(){
    clearTimeout(ambTimer); ambTimer = null;
    if (mode !== "all" || !AMB[theme] || !ctx) return;
    ambTimer = setTimeout(() => {
      const onTable = !document.getElementById("view-table").hidden;
      if (onTable && !document.hidden && ctx.state === "running"){ try { ambient(); } catch (e) { console.warn("sound", e); } }
      scheduleAmb();
    }, rand(10000, 24000));
  }

  const api = {
    label: () => LABEL[mode],
    cycle(){
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      try { localStorage.setItem("dmh.sound", mode); } catch {}
      if (mode === "off"){ clearTimeout(ambTimer); ambTimer = null; } else if (ctx) scheduleAmb();
    },
    setTheme(t){ theme = t; if (ctx) scheduleAmb(); },
    unlock(){ ready(); }
  };
  Object.keys(V).forEach(k => {
    api[k] = () => { if (!ready()) return; try { V[k](); } catch (e) { console.warn("sound", e); } };
  });
  return api;
})();

function sfxDiff(prev, cur){
  if (!prev || !cur) return;
  const traitsLeft = r => (r.seats || []).reduce((a, s) => a + Object.keys(s.traits || {}).reduce((b, k) => b + (s.traits[k].cap - s.traits[k].used), 0), 0);
  if (cur.phase === "over" && prev.phase !== "over") return sfx.over();
  if (cur.reveal && (!prev.reveal || prev.reveal.id !== cur.reveal.id)) return sfx.reveal();
  if (cur.phase === "bidding" && ((cur.round || 0) > (prev.round || 0) || prev.phase === "lobby")){
    const was = (prev.seats || []).reduce((a, s) => a + s.count, 0), now = (cur.seats || []).reduce((a, s) => a + s.count, 0);
    if (now < was) sfx.lose();
    return sfx.deal();
  }
  if (cur.phase === "bidding" && prev.phase === "bidding" && cur.pokerFace && !prev.pokerFace) return sfx.trait();
  if (traitsLeft(cur) < traitsLeft(prev)) return sfx.trait();
  const pb = prev.bid, cb = cur.bid;
  if (cb && (!pb || pb.count !== cb.count || pb.face !== cb.face || pb.by !== cb.by)){
    return (cur.turn === mySeat) ? sfx.turn() : sfx.bid();
  }
  if (cur.phase === "bidding" && cur.turn !== prev.turn && cur.turn === mySeat) sfx.turn();
}

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
function traitsFor(name){
  const grant = PROFICIENCIES[name] || {};
  const t = {};
  TRAITS.forEach(tr => { t[tr.id] = { cap: grant[tr.id] || 0, used: 0 }; });
  return t;
}
function traitCap(seat, id){ return (seat && seat.traits && seat.traits[id] && seat.traits[id].cap) || 0; }
function traitUsed(seat, id){ return (seat && seat.traits && seat.traits[id] && seat.traits[id].used) || 0; }
function traitLeft(seat, id){ return traitCap(seat, id) - traitUsed(seat, id); }
function spendTrait(seat, id){
  seat.traits = seat.traits || {};
  seat.traits[id] = seat.traits[id] || { cap:0, used:0 };
  seat.traits[id].used++;
}
function traitsLeftTotal(seat){
  if (!seat || !seat.traits) return 0;
  return Object.keys(seat.traits).reduce((a,id) => a + traitLeft(seat, id), 0);
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

function npcSeatsFor(opponent, pcCount){
  const npc = (name, count) => ({ id:uid(), name, kind:"npc", dice:[], count, out:false, traits:traitsFor(name), claimed:true });
  if (opponent === "king") return [npc("Vander Boone", 5), npc("Lyla Webb", 5)];
  if (opponent === "sinner") return [npc("Mister Crossroads", 5 + pcCount)];
  return [npc("The House", 5)];
}

function makeRoom(opponent, names){
  const seats = names.map(n => ({
    id:uid(), name:n, kind:"pc", dice:[], count:5, out:false, traits:traitsFor(n), claimed:false
  })).concat(npcSeatsFor(opponent, names.length));
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
  if (!s || s.out || traitLeft(s, t.id) <= 0) return;

  if (t.id === "fated"){
    s.dice = rollN(s.dice.length); spendTrait(s, t.id);
    logAdd(`<b>${esc(s.name)}</b> calls <span class="hi">Fated Luck</span>.`);
    return save();
  }
  if (t.id === "poker"){
    room.pokerFace = { by:s.id }; spendTrait(s, t.id);
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
  spendTrait(me, armed); armed = null; save();
}

function setDie(i, val){
  const me = seatById(mySeat); if (!me) return;
  me.dice[i] = val;
  if (armed === "deft"){
    spendTrait(me, "deft"); armed = null;
    logAdd(`<b>${esc(me.name)}</b> uses <span class="hi">Deft Hands</span>.`);
  }
  selDie = -1; save();
}

/* ---------------- views ---------------- */

function show(view){
  ["landing","lobby","table"].forEach(v => {
    $("view-" + v).hidden = (v !== view);
  });
  if (view === "landing") setTheme("sinner");
}

function setTheme(t){
  if (document.body.dataset.theme === t) return;
  document.body.dataset.theme = t;
  sfx.setTheme(t);
}

function render(){
  if (!room){ show("landing"); return; }
  setTheme(room.opponent);
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
  const opp = $("lobbyOpp").value;
  $("lobbyPool").textContent = opp === "sinner"
    ? `Mister Crossroads opens on ${5 + n} dice: five, plus one for every character who sits down.`
    : opp === "test"
      ? "A plain table with one house seat on five dice. For trying things out."
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
        <span class="st">${s.out ? "out" : (s.kind === "npc" ? "the house" : "player")} · ${traitsLeftTotal(s)} trait${traitsLeftTotal(s) === 1 ? "" : "s"}</span>
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
    : `${me.dice.length} ${me.dice.length === 1 ? "die" : "dice"} · ${traitsLeftTotal(me)} trait${traitsLeftTotal(me) === 1 ? "" : "s"} left`;

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
    const s = seatById(mySeat); spendTrait(s, "daring");
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
  const left = traitsLeftTotal(me);
  $("traitsLeft").textContent = left === 1 ? "1 use" : left + " uses";
  const wrap = $("traits");
  if (!me || me.out){
    wrap.innerHTML = `<p class="hint">No traits without a seat.</p>`; return;
  }
  const granted = TRAITS.filter(t => traitCap(me, t.id) > 0);
  if (!granted.length){
    wrap.innerHTML = `<p class="hint">No trait proficiencies on this sheet.</p>`; return;
  }
  wrap.innerHTML = granted.map(t => {
    const remain = traitLeft(me, t.id), cap = traitCap(me, t.id);
    const spent = remain <= 0;
    return `<button class="trait ${armed === t.id ? "armed" : ""}" data-trait="${t.id}" ${spent ? "disabled" : ""}>
      <b>${t.name}</b><span>${t.skill} · ${t.desc} · ${remain}/${cap} left</span></button>`;
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
      <td class="n">${traitsLeftTotal(s)}</td>
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
    : room.opponent === "test"
      ? `<div class="note green"><b>Test table</b>One house seat. Bid and challenge for it from this panel on its turn.</div>`
      : `<div class="note green"><b>You know both their hands</b>Vander and Lyla signal each other under the table.
        Play them as a pair quietly working together, and let it show once or twice.</div>`;

  const turnSeat = seatById(room.turn);
  const housesTurn = room.phase === "bidding" && turnSeat && turnSeat.kind === "npc";
  if (housesTurn){
    h += `<div class="note mag" style="margin-top:12px">
      <b>${esc(turnSeat.name)}'s move</b>
      <div class="bidrow" style="margin-top:8px">
        <div class="field" style="margin:0">
          <label>How many</label>
          <div class="stepper">
            <button id="hMinus" aria-label="Fewer">&minus;</button>
            <div class="n">${draft.count}</div>
            <button id="hPlus" aria-label="More">+</button>
          </div>
        </div>
        <div class="field" style="margin:0">
          <label>Showing</label>
          <div class="faces">` +
            [1,2,3,4,5,6].map(f => `<button class="${draft.face === f ? "on" : ""}" data-hface="${f}">${dieHTML(f,"sm")}</button>`).join("") +
          `</div>
        </div>
      </div>
      <div class="actions" style="margin-top:8px">
        <button class="btn primary" id="hBid">Bid ${draft.count} &times; ${draft.face}</button>
        ${room.bid ? `<button class="btn danger" id="hChal">Challenge</button>` : ""}
      </div>
    </div>`;
  }

  if (!mySeat){
    if (room.phase === "reveal"){
      h += `<div class="actions" style="margin-top:12px"><button class="btn primary" id="dNext">Next round</button></div>`;
    } else if (room.phase === "over"){
      h += `<div class="actions" style="margin-top:12px"><button class="btn primary" id="dNew">New table</button></div>`;
    } else if (room.phase === "bidding"){
      h += `<div class="actions" style="margin-top:12px;border-top:1px solid var(--line-soft);padding-top:12px">
        <button class="btn ghost sm" id="dRedeal">Redeal round</button>
        <button class="btn ghost sm" id="dNewT">New table</button></div>`;
    }
  }

  $("dealerBody").innerHTML = h;

  const whisper = s => `${s.name} — your hand: ${s.dice.join("  ")}   (ones are wild). ` +
    `${traitsLeftTotal(s)} trait use${traitsLeftTotal(s) === 1 ? "" : "s"} left.`;
  $("dealerBody").querySelectorAll("[data-wh]").forEach(b => {
    b.onclick = async () => {
      const s = seatById(b.dataset.wh);
      try { await navigator.clipboard.writeText(whisper(s)); toast(`Copied ${s.name}'s hand.`); }
      catch { toast(whisper(s)); }
    };
  });
  if (housesTurn){
    const hMinus = $("hMinus"), hPlus = $("hPlus"), hBid = $("hBid"), hChal = $("hChal");
    if (hMinus) hMinus.onclick = () => { draft.count = Math.max(1, draft.count - 1); render(); };
    if (hPlus)  hPlus.onclick  = () => { draft.count = Math.min(potCount(), draft.count + 1); render(); };
    $("dealerBody").querySelectorAll("[data-hface]").forEach(b => {
      b.onclick = () => { draft.face = +b.dataset.hface; render(); };
    });
    if (hBid) hBid.onclick = () => {
      if (room.bid){
        const ok = draft.count > room.bid.count ||
                   (draft.count === room.bid.count && draft.face > room.bid.face);
        if (!ok) return toast("That does not raise it. Go higher on the count, the face, or both.");
      }
      placeBid(draft.count, draft.face);
    };
    if (hChal) hChal.onclick = doChallenge;
  }

  if (!mySeat){
    const dNext = $("dNext"), dNew = $("dNew"), dRedeal = $("dRedeal"), dNewT = $("dNewT");
    if (dNext) dNext.onclick = nextRound;
    if (dNew) dNew.onclick = () => { room.phase = "lobby"; room.round = 0; save(); };
    if (dRedeal) dRedeal.onclick = () => {
      room.seats.forEach(s => { if (!s.out) s.dice = rollN(s.count); });
      logAdd("The dealer redeals the round."); lastRound = -1; save();
    };
    if (dNewT) dNewT.onclick = () => { room.phase = "lobby"; room.round = 0; save(); };
  }

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
  roomCode = code; lastSnap = null;
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
    try { sfxDiff(lastSnap, v); } catch (e) { console.warn("sound", e); }
    lastSnap = JSON.parse(JSON.stringify(v));
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
  room = makeRoom("king", ["Sassafras","Sister Maple","Fizzwick","Ryn"]);
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
const paintSound = () => { $("btnSound").textContent = sfx.label(); };
paintSound();
$("btnSound").onclick = () => { sfx.cycle(); paintSound(); sfx.unlock(); sfx.bid(); };
document.addEventListener("pointerdown", () => sfx.unlock(), { once: true });
$("btnCast").onclick = () => {
  castMode = !castMode;
  $("btnCast").textContent = castMode ? "Casting" : "Cast";
  toast(castMode ? "Your hand is hidden. Safe to share the screen." : "Your hand is back.");
  render();
};
$("lobbyOpp").onchange = () => {
  room.opponent = $("lobbyOpp").value;
  const pcs = room.seats.filter(s => s.kind === "pc");
  room.seats = pcs.concat(npcSeatsFor(room.opponent, pcs.length));
  updatePool(); save();
};
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
