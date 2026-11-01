/* ===========================================================
   Table sounds, shared by the dice game and the poker game.
   Everything is made from filtered noise, so it sounds like a room
   rather than a machine: dice on timber, cards on felt, knuckles on
   the rail, creaking boards, water. There are no tones to ping.
   Quiet on purpose; the dealer will have music on.
   =========================================================== */

export const sfx = (() => {
  const MODES = ["all", "dice", "off"];
  const LABEL = { all:"Sound: all", dice:"Sound: dice", off:"Sound: off" };
  const FEEL = {
    plain:  { knock:150, tick:[1500, 4600] },
    king:   { knock:112, tick:[900, 3300] },
    sinner: { knock:92,  tick:[1000, 3700] },
    poker:  { knock:105, tick:[1100, 3600] }
  };
  let ctx = null, bus = null, wet = null, noiseBuf = null;
  let mode = "all", theme = "landing", ambTimer = null;
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
    /* cards: a slide across felt, then the soft tap of it landing */
    cards(){
      for (let i = 0; i < 10; i++){
        const s = i * 0.11 + Math.random() * 0.02;
        rustle(s, 0.1, 0.55, 2400, 9000, 0.25);
        click(s + 0.075, rand(700, 1100), 1.2, 0.04, 0.5, 0.3);
      }
    },
    flip(){
      rustle(0, 0.12, 0.6, 2400, 9000, 0.25); click(0.09, rand(900, 1300), 1.4, 0.05, 0.5, 0.3);
    },
    draw(){
      for (let i = 0; i < 3; i++){ rustle(i * 0.15, 0.1, 0.5, 2400, 9000, 0.25); click(i * 0.15 + 0.075, rand(700, 1100), 1.2, 0.04, 0.45, 0.3); }
    },
    /* the cheat: a breath of dark and a board settling, deliberately quiet */
    shadow(){
      swell(0, 1.8, 520, 50, 0.7, 0.5, 5, 0.9);
      creak(0.2, 1.0, 200, 90, 0.8);
      rustle(0.3, 0.8, 0.25, 300, 2500, 0.6);
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
    poker: [
      () => creak(0, rand(1.0, 1.8), rand(130, 220), rand(80, 150), 3.2),
      () => drip(0, 1.4),
      () => swell(0, 2.6, 240, 60, 1.1, 0, 9, 0.9),
      () => rustle(0, 0.6, 0.3, 2500, 7000)
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
