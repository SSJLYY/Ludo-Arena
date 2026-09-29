// 音效：WebAudioContext 合成（零音频资源，保持主包轻量），可静音
// 基础库 2.19+ 支持 wx.createWebAudioContext；低版本静默降级
let ctx = null;
let enabled = true;

try {
  enabled = wx.getStorageSync('fc_muted') !== '1';
} catch (e) { /* 忽略 */ }

function ensure() {
  if (!ctx) {
    try { ctx = wx.createWebAudioContext(); } catch (e) { ctx = null; }
  }
  return ctx;
}

function tone(freq, dur, delay, type, gain) {
  if (!enabled) return;
  const ac = ensure();
  if (!ac) return;
  try {
    const t0 = ac.currentTime + (delay || 0);
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain || 0.12, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  } catch (e) { /* 音频失败静默 */ }
}

module.exports = {
  // 骰子翻滚：一串短促咔哒
  dice() {
    for (let i = 0; i < 5; i++) {
      tone(180 + Math.random() * 120, 0.05, i * 0.09, 'square', 0.06);
    }
  },
  // 逐格移动
  hop() {
    tone(620, 0.06, 0, 'triangle', 0.08);
  },
  // 起飞
  takeoff() {
    tone(440, 0.1, 0, 'triangle', 0.1);
    tone(660, 0.12, 0.09, 'triangle', 0.1);
  },
  // 撞子：低沉下滑 + 震动
  kill() {
    tone(320, 0.18, 0, 'sawtooth', 0.14);
    tone(180, 0.22, 0.1, 'sawtooth', 0.12);
    try { wx.vibrateShort({ type: 'medium' }); } catch (e) { /* 忽略 */ }
  },
  // 进终点
  home() {
    tone(523, 0.1, 0, 'sine', 0.12);
    tone(659, 0.1, 0.1, 'sine', 0.12);
    tone(784, 0.16, 0.2, 'sine', 0.12);
  },
  // v1.6 获得道具卡
  gain() {
    tone(660, 0.08, 0, 'sine', 0.1);
    tone(990, 0.12, 0.07, 'sine', 0.1);
  },
  // 胜利琶音
  win() {
    const seq = [523, 659, 784, 1047];
    seq.forEach((f, i) => tone(f, 0.22, i * 0.13, 'triangle', 0.14));
    try { wx.vibrateShort({ type: 'heavy' }); } catch (e) { /* 忽略 */ }
  },
  // 轮到我了
  turn() {
    tone(440, 0.1, 0, 'sine', 0.1);
    tone(440, 0.1, 0.14, 'sine', 0.1);
  },
  isEnabled() {
    return enabled;
  },
  toggle() {
    enabled = !enabled;
    try { wx.setStorageSync('fc_muted', enabled ? '0' : '1'); } catch (e) { /* 忽略 */ }
    return enabled;
  }
};
