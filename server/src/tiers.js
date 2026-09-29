/**
 * tiers.js — 段位系统（按累计胜场派生的展示型段位，纯函数）
 *
 * 段位只影响展示（战绩榜 / 个人战绩），不影响任何对局规则。
 * 与 miniprogram/engine/tiers.js 同源。
 */

const TIERS = [
  { id: 'bronze', name: '青铜', min: 0, icon: '🥉', color: '#b87333' },
  { id: 'silver', name: '白银', min: 3, icon: '🥈', color: '#9aa7b8' },
  { id: 'gold', name: '黄金', min: 10, icon: '🥇', color: '#f0b429' },
  { id: 'platinum', name: '铂金', min: 25, icon: '💠', color: '#4fd1c5' },
  { id: 'diamond', name: '王者', min: 50, icon: '👑', color: '#a78bfa' },
];

/** 当前段位（wins 为累计胜场） */
function tierOf(wins) {
  const w = wins > 0 ? wins : 0;
  let cur = TIERS[0];
  for (let i = 0; i < TIERS.length; i += 1) {
    if (w >= TIERS[i].min) cur = TIERS[i];
  }
  return cur;
}

/** 升入下一段位还差几胜（已是最高段位返回 -1） */
function winsToNext(wins) {
  const w = wins > 0 ? wins : 0;
  for (let i = 0; i < TIERS.length; i += 1) {
    if (w < TIERS[i].min) return TIERS[i].min - w;
  }
  return -1;
}

/** 距离下一段位的进度（0~1，已满级返回 1） */
function tierProgress(wins) {
  const w = wins > 0 ? wins : 0;
  const cur = tierOf(w);
  const idx = TIERS.findIndex((t) => t.id === cur.id);
  const next = TIERS[idx + 1];
  if (!next) return 1;
  return Math.max(0, Math.min(1, (w - cur.min) / (next.min - cur.min)));
}

module.exports = { TIERS, tierOf, winsToNext, tierProgress };
