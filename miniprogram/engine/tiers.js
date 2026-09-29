'use strict';

// ============================================================
// 段位系统（v1.7）—— 按累计胜场派生的展示型段位，纯函数
// 段位只影响展示（我的页 / 排行榜），不影响任何对局规则。
// ============================================================

var TIERS = [
  { id: 'bronze', name: '青铜', min: 0 },
  { id: 'silver', name: '白银', min: 3 },
  { id: 'gold', name: '黄金', min: 10 },
  { id: 'platinum', name: '铂金', min: 25 },
  { id: 'diamond', name: '王者', min: 50 }
];

// 当前段位（wins 为累计胜场）
function tierOf(wins) {
  var w = wins > 0 ? wins : 0;
  var cur = TIERS[0];
  for (var i = 0; i < TIERS.length; i++) {
    if (w >= TIERS[i].min) cur = TIERS[i];
  }
  return cur;
}

// 升入下一段位还差几胜（已是最高段位返回 -1）
function winsToNext(wins) {
  var w = wins > 0 ? wins : 0;
  for (var i = 0; i < TIERS.length; i++) {
    if (w < TIERS[i].min) return TIERS[i].min - w;
  }
  return -1;
}

module.exports = {
  TIERS: TIERS,
  tierOf: tierOf,
  winsToNext: winsToNext
};
