/* fx.js — 音效（WebAudio 合成，零资源文件）+ 震动反馈 */
(function (global) {
  'use strict';

  let ctx = null;
  let enabled = true;
  let vibration = true;
  let bgmOn = true;
  let bgmNodes = null;

  /** 背景音乐：WebAudio 合成的柔和循环 pad，零资源文件 */
  function bgmStart() {
    if (!enabled || !bgmOn || bgmNodes) return;
    const a = ac(); if (!a) return;
    const master = a.createGain();
    master.gain.value = 0.05;
    master.connect(a.destination);
    const freqs = [220, 277.18, 329.63, 164.81]; // A 大调叠加，舒缓
    const nodes = freqs.map((f, i) => {
      const o = a.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = a.createGain();
      g.gain.value = 0.22 / freqs.length;
      const lfo = a.createOscillator();
      lfo.frequency.value = 0.05 + i * 0.017; // 缓慢起伏，避免单调
      const lfoG = a.createGain();
      lfoG.gain.value = 0.12 / freqs.length;
      lfo.connect(lfoG).connect(g.gain);
      o.connect(g).connect(master);
      o.start();
      lfo.start();
      return { o, lfo };
    });
    bgmNodes = { master, nodes };
  }

  function bgmStop() {
    if (!bgmNodes) return;
    try { bgmNodes.nodes.forEach((n) => { n.o.stop(); n.lfo.stop(); }); } catch (e) { /* ignore */ }
    bgmNodes = null;
  }

  function ac() {
    if (!ctx) {
      try { ctx = new (global.AudioContext || global.webkitAudioContext)(); }
      catch (e) { enabled = false; return null; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /** 基础音：osc 类型 + 频率包络 + 增益包络 */
  function tone({ type = 'sine', f0 = 440, f1 = null, dur = 0.15, vol = 0.2, delay = 0 }) {
    if (!enabled) return;
    const a = ac(); if (!a) return;
    const t0 = a.currentTime + delay;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(a.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  function noise({ dur = 0.3, vol = 0.3, delay = 0 }) {
    if (!enabled) return;
    const a = ac(); if (!a) return;
    const t0 = a.currentTime + delay;
    const len = Math.floor(a.sampleRate * dur);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = a.createBufferSource();
    const g = a.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.buffer = buf;
    src.connect(g).connect(a.destination);
    src.start(t0);
  }

  function buzz(pattern) {
    if (!vibration) return;
    if (global.navigator && global.navigator.vibrate) {
      try { global.navigator.vibrate(pattern); } catch (e) { /* ignore */ }
    }
  }

  const Sfx = {
    init() { ac(); }, // 首次用户手势时调用，解锁 AudioContext
    setEnabled(v) {
      enabled = !!v;
      if (enabled) bgmStart(); else bgmStop();
    },
    setVibration(v) { vibration = !!v; },
    setBgm(v) { bgmOn = !!v; if (enabled && bgmOn) bgmStart(); else bgmStop(); },
    get enabled() { return enabled; },
    get vibration() { return vibration; },
    get bgmOn() { return bgmOn; },

    dice() { // 掷骰：嗒嗒嗒
      for (let i = 0; i < 5; i++) tone({ type: 'square', f0: 300 + Math.random() * 200, dur: 0.05, vol: 0.08, delay: i * 0.07 });
      buzz(30);
    },
    diceResult(n) { // 骰子定格，6 更亮
      tone({ type: 'triangle', f0: n === 6 ? 880 : 520, f1: n === 6 ? 1320 : 520, dur: 0.18, vol: 0.22 });
      if (n === 6) { tone({ type: 'sine', f0: 1100, f1: 1500, dur: 0.25, vol: 0.18, delay: 0.12 }); buzz([40, 40, 40]); }
    },
    takeoff() { // 起飞：上升音
      tone({ type: 'sine', f0: 400, f1: 900, dur: 0.3, vol: 0.25 });
      buzz(50);
    },
    move() { // 走子：短促啾
      tone({ type: 'sine', f0: 600, f1: 900, dur: 0.12, vol: 0.15 });
    },
    kill() { // 撞子：爆炸
      noise({ dur: 0.35, vol: 0.4 });
      tone({ type: 'sawtooth', f0: 200, f1: 60, dur: 0.35, vol: 0.3 });
      buzz([60, 30, 60]);
    },
    killed() { // 被撞：下坠
      tone({ type: 'sawtooth', f0: 500, f1: 100, dur: 0.5, vol: 0.3 });
      buzz([80, 40, 80, 40, 80]);
    },
    home() { // 到家：叮咚
      tone({ type: 'sine', f0: 784, dur: 0.15, vol: 0.22 });
      tone({ type: 'sine', f0: 1046, dur: 0.25, vol: 0.22, delay: 0.12 });
      buzz(40);
    },
    jump() { // 跳格：双音
      tone({ type: 'triangle', f0: 660, dur: 0.1, vol: 0.18 });
      tone({ type: 'triangle', f0: 880, dur: 0.12, vol: 0.18, delay: 0.1 });
    },
    win() { // 胜利：小旋律
      [523, 659, 784, 1046].forEach((f, i) => tone({ type: 'triangle', f0: f, dur: 0.28, vol: 0.25, delay: i * 0.16 }));
      buzz([100, 50, 100, 50, 200]);
    },
    lose() { // 失败：低沉
      tone({ type: 'sine', f0: 300, f1: 150, dur: 0.6, vol: 0.25 });
      buzz(150);
    },
    myTurn() { // 轮到自己：轻提示
      tone({ type: 'sine', f0: 880, dur: 0.12, vol: 0.15 });
      tone({ type: 'sine', f0: 1174, dur: 0.15, vol: 0.15, delay: 0.1 });
    },
    skip() { // 无棋可走
      tone({ type: 'sine', f0: 350, f1: 250, dur: 0.2, vol: 0.15 });
    },
  };

  global.Sfx = Sfx;
})(window);
