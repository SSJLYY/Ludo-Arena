/**
 * rules.js — 飞行棋规则常量与棋盘工具函数（前后端共用）
 *
 * 棋盘模型：
 *   - 主环 MAIN_RING = 52 格，正方形每边 13 格
 *   - 四色起飞点：红 0 / 黄 13 / 蓝 26 / 绿 39
 *   - 每方 4 架飞机，归航道 LANE_LEN = 5 格
 *   - 位置编码 rp（相对步数）：
 *       -1         = 基地（未起飞）
 *        0         = 起飞点（主环第 0 格）
 *       0 ~ 51     = 主环行进（绕一圈 52 格）
 *       52 ~ 56    = 己方归航道（安全区）
 *       57         = 终点 HOME
 */

const COLORS = ['red', 'yellow', 'blue', 'green'];

// 每方起飞点在主环上的绝对格位
const COLOR_OFFSET = { red: 0, yellow: 13, blue: 26, green: 39 };

const MAIN_RING = 52;
const LANE_LEN = 5;
const FINISH_RP = 57;          // 终点 rp（归航道末格 56 + 1）
const PLANES_PER_PLAYER = 4;
const MAX_EXTRA_SIX = 3;       // 连续掷 6 次数上限，满则本回合作废

// v1.1 飞行箭头：rp 36 是己色格（36 % 4 === 0），落上沿航线飞跃 12 格至 rp 48
const FLY_RP = 36;
const FLY_DIST = 12;

// 安全格：四角起飞点为绝对安全格，敌方落上不被撞
const SAFE_CELLS = [0, 13, 26, 39];

// v3 道具格：主环每 13 格一处（避开起飞/安全格），飞机落上拾取随机道具。
// 选点：各 13 段中央偏前（6 / 19 / 32 / 45），均非安全格、非飞行箭头落点。
const ITEM_CELLS = [6, 19, 32, 45];

// v3 四种道具（与前端 app.js 的 ITEM_META 保持一致）
const ITEM_TYPES = ['bomb', 'shield', 'accel', 'swap'];

function isItemCell(abs) { return ITEM_CELLS.indexOf(abs) >= 0; }

/**
 * 计算某颜色某 rp 对应的主环绝对格位。
 * 仅当 rp ∈ [0, 51]（在主环上）有效；归航道/终点返回 null。
 */
function absCell(color, rp) {
  if (rp < 0 || rp > MAIN_RING - 1) return null;
  return (COLOR_OFFSET[color] + rp) % MAIN_RING;
}

/**
 * 判断主环绝对格位是否为某颜色的同色格（用于跳格）。
 * 同色格定义：absIdx ≡ COLOR_OFFSET[color] (mod 4)
 */
function isSameColorCell(color, absIdx) {
  return ((absIdx - COLOR_OFFSET[color]) % 4 + 4) % 4 === 0;
}

/**
 * 判断绝对格位是否为安全格。
 */
function isSafeCell(absIdx) {
  return SAFE_CELLS.includes(absIdx);
}

/**
 * 跳格目标：若当前绝对格位是该颜色同色格，则前进 4 格到下一个同色格。
 * 仅当不超出主环（target <= 51）时生效，避免误入归航道。
 * @returns 跳格后的 rp，或原 rp（不跳）
 */
function jumpTarget(color, rp) {
  const abs = absCell(color, rp);
  if (abs === null) return rp;
  if (!isSameColorCell(color, abs)) return rp;
  const nextRp = rp + 4;
  if (nextRp > MAIN_RING - 1) return rp; // 不越界到归航道
  return nextRp;
}

/**
 * 落点跃迁规划（v1.1）：落己色格时——
 *   箭头格 rp 36 且 allowFly → 飞跃 12 格至 rp 48；
 *   否则跳到下一个同色格（+4）。
 * 裁定：不连锁（一次落定只触发一次）；+4 会越过归航道口则不跳。
 * @returns { type:'fly'|'jump', target } | null
 */
function planHop(game, color, rp) {
  if (rp < 0 || rp > MAIN_RING - 1) return null;
  if (!isSameColorCell(color, absCell(color, rp))) return null; // 非己色格不触发
  if (game && game.allowFly !== false && rp === FLY_RP) {
    return { type: 'fly', target: rp + FLY_DIST }; // 48，恒在主环内
  }
  if (game && game.allowJump === false) return null;
  if (rp + 4 > MAIN_RING - 1) return null;
  return { type: 'jump', target: rp + 4 };
}

module.exports = {
  COLORS,
  COLOR_OFFSET,
  MAIN_RING,
  LANE_LEN,
  FINISH_RP,
  PLANES_PER_PLAYER,
  MAX_EXTRA_SIX,
  FLY_RP,
  FLY_DIST,
  SAFE_CELLS,
  absCell,
  isSameColorCell,
  isSafeCell,
  jumpTarget,
  planHop,
  ITEM_CELLS,
  ITEM_TYPES,
  isItemCell,
};
