'use strict';

// ============================================================
// 飞行棋规则常量（v1）—— 前后端共用（客户端表现层 + 云函数权威结算）
//
// 位置编码 rp（相对步数）：
//   -1        基地（未起飞）
//   0..51     主环（52 格，0 = 己方起飞点）
//   52..56    己方归航道（5 格）
//   57        终点 HOME
//
// 座位顺序即行动顺序：0 红(左上) / 1 黄(右上) / 2 蓝(右下) / 3 绿(左下)
// ============================================================

var COLORS = ['red', 'yellow', 'blue', 'green'];
var COLOR_NAMES = ['红方', '黄方', '蓝方', '绿方'];

var BASE_RP = -1;
var TRACK_LEN = 52;      // 主环格数
var LANE_START = 52;     // 归航道起始 rp
var LANE_LEN = 5;        // 归航道格数
var HOME_RP = 57;        // 终点 rp（终点步数 57）
var MAX_SIX_STREAK = 3;  // 连掷 6 上限，第 3 次作废本回合

// 飞行箭头（v1.1）：每色 rp 36 的己色格为箭头格，落上飞跃 12 格至 rp 48
var FLY_RP = 36;
var FLY_DIST = 12;

// 各座位起飞点在主环上的绝对格位（见 board.js 棋盘布局推导）
var START_OFFSET = [51, 12, 25, 38];
// 四角起飞点 = 安全格，敌方落此格不可撞子
var SAFE_ABS = [51, 12, 25, 38];

// 主环颜色归属：每色 13 格、间隔 4（跳格 +4 的依据）
// abs % 4 → [0→黄 1→蓝 2→绿 3→红]
var ABS_COLOR_MAP = [1, 2, 3, 0];

function normalizeAbs(abs) {
  return ((abs % TRACK_LEN) + TRACK_LEN) % TRACK_LEN;
}

// 主环绝对格位 → 座位（颜色）归属
function colorOfAbs(abs) {
  return ABS_COLOR_MAP[normalizeAbs(abs) % 4];
}

// 座位 + rp → 主环绝对格位（仅 rp ≤ 51 时有意义）
function absOfRp(seat, rp) {
  return normalizeAbs(START_OFFSET[seat] + rp);
}

function isSafeAbs(abs) {
  return normalizeAbs(abs) % 13 === 12; // 51/12/25/38 四个起飞点
}

// rp 落点是否在己方同色格上（跳格触发条件）
function isOwnColor(seat, rp) {
  if (rp < 0 || rp > 51) return false;
  return colorOfAbs(absOfRp(seat, rp)) === seat;
}

// 归航道入口绝对格位（进港前最后一个主环格）
function laneEntranceAbs(seat) {
  return normalizeAbs(START_OFFSET[seat] - 1);
}

// 各座位飞行箭头格的绝对格位（rp 36，必为己色格）
function arrowAbsOf(seat) {
  return absOfRp(seat, FLY_RP);
}

module.exports = {
  COLORS: COLORS,
  COLOR_NAMES: COLOR_NAMES,
  BASE_RP: BASE_RP,
  TRACK_LEN: TRACK_LEN,
  LANE_START: LANE_START,
  LANE_LEN: LANE_LEN,
  HOME_RP: HOME_RP,
  MAX_SIX_STREAK: MAX_SIX_STREAK,
  FLY_RP: FLY_RP,
  FLY_DIST: FLY_DIST,
  START_OFFSET: START_OFFSET,
  SAFE_ABS: SAFE_ABS,
  colorOfAbs: colorOfAbs,
  absOfRp: absOfRp,
  normalizeAbs: normalizeAbs,
  isSafeAbs: isSafeAbs,
  isOwnColor: isOwnColor,
  laneEntranceAbs: laneEntranceAbs,
  arrowAbsOf: arrowAbsOf
};
