/**
 * ai.js — 飞行棋 AI 启发式决策（前后端共用）
 *
 * v2.0 新增：
 *   - 护盾目标重罚（撞带盾飞机会被反震回基地，AI 不踩盾）
 *   - wantsReroll：普通及以上档位，候选全负分时自动用重掷卡
 *
 * choosePlane(game, seat, dice, difficulty) → planeId | null
 *   difficulty: 1 简单 / 2 普通 / 3 困难 / 4 大师
 */

const { computeLegalMoves, applyMove } = require('./move');
const { MAIN_RING, FINISH_RP, absCell, isSafeCell } = require('./rules');

const WEIGHTS = {
  kill: 100,
  reachHome: 120,
  enterLane: 40,
  takeOff: 35,
  landSafe: 20,
  stack: 15,
  jumpGain: 2,
  flyGain: 3,
  progress: 1.5,
  underdog: 10,
  riskPerDist: -30,
  shieldBlocked: -150, // 撞带盾目标会被反震回基地，重罚
};

/**
 * 计算落点后方 1-6 格内是否有敌方 track 飞机，返回最小威胁距离（无则 0）。
 */
function threatDistance(game, seat, landedRp) {
  if (landedRp < 0 || landedRp > MAIN_RING - 1) return 0;
  const myAbs = absCell(game.players[seat].color, landedRp);
  let best = 0;
  for (const other of game.players) {
    if (other.seat === seat) continue;
    for (const op of other.planes) {
      if (op.rp < 0 || op.rp > MAIN_RING - 1) continue;
      const oAbs = absCell(other.color, op.rp);
      const dist = (myAbs - oAbs + MAIN_RING) % MAIN_RING;
      if (dist >= 1 && dist <= 6 && (best === 0 || dist < best)) best = dist;
    }
  }
  return best;
}

/**
 * v13 风格权重修正：aggressive 偏进攻（强化击落/冒进、弱化避险），
 * defensive 偏保守（强化安全格、强化避险、弱化冒进），balanced 用基准权重。
 */
function styleWeights(style) {
  const w = Object.assign({}, WEIGHTS);
  if (style === 'aggressive') {
    w.kill *= 1.6; w.underdog *= 1.5; w.landSafe *= 0.6; w.riskPerDist *= 0.45;
  } else if (style === 'defensive') {
    w.kill *= 0.8; w.underdog *= 0.7; w.landSafe *= 1.5; w.riskPerDist *= 1.8; w.takeOff *= 0.85;
  }
  return w;
}

function scoreMove(game, seat, planeId, dice, style) {
  const W = styleWeights(style);
  const sim = applyMove(game, seat, planeId, dice);
  const res = sim.game;
  const plane = res.players[seat].planes.find((x) => x.id === planeId);
  const landed = plane.rp;
  let s = 0;

  const killedEvents = sim.events.filter((e) => e.type === 'kill');
  if (killedEvents.length) {
    const victimProgress = killedEvents.reduce((sum, e) => {
      const v = game.players[e.victimSeat].planes.find((x) => x.id === e.victimPlaneId);
      return sum + (v ? v.rp : 0);
    }, 0);
    s += W.kill * (1 + victimProgress / FINISH_RP);
  }
  // 撞到带护盾的目标：护盾抵消 + 自己被反震回基地
  if (sim.events.some((e) => e.type === 'shield_block')) s += W.shieldBlocked;

  if (landed === FINISH_RP) s += W.reachHome;
  if (landed >= 52 && landed < FINISH_RP) s += W.enterLane;

  const before = game.players[seat].planes.find((x) => x.id === planeId);
  if (before.rp === -1) s += W.takeOff;

  if (landed >= 0 && landed <= MAIN_RING - 1) {
    const abs = absCell(res.players[seat].color, landed);
    if (isSafeCell(abs)) s += W.landSafe;
    const td = threatDistance(game, seat, landed);
    if (td > 0) s += W.riskPerDist / td;
  }

  const jumpEvt = sim.events.find((e) => e.type === 'jump');
  if (jumpEvt) s += (jumpEvt.to - jumpEvt.from) * W.jumpGain;
  const flyEvt = sim.events.find((e) => e.type === 'fly');
  if (flyEvt) s += (flyEvt.to - flyEvt.from) * W.flyGain;
  s += (landed - before.rp) * W.progress;
  s += (1 - landed / FINISH_RP) * W.underdog;
  return s;
}

/**
 * 大师档（4）：两层数期望回推 —— 下家 6 种骰子的最优收益均值按 0.4 计入负分，
 * 能看见基础风险项看不到的间接杀招与静止飞机暴露。
 */
function masterScore(game, seat, dice, style) {
  const moves = computeLegalMoves(game, seat, dice);
  if (!moves.length) return -Infinity;
  let best = -Infinity;
  for (const m of moves) {
    const sim = applyMove(game, seat, m.planeId, dice);
    let s = scoreMove(game, seat, m.planeId, dice, style);
    // 对手回应：下家 6 种骰子里最好的一手，折算成对我的威胁
    const nextSeat = (seat + 1) % game.players.length;
    let oppBest = -Infinity;
    for (let d = 1; d <= 6; d += 1) {
      const oppMoves = computeLegalMoves(sim.game, nextSeat, d);
      for (const om of oppMoves) {
        const v = scoreMove(sim.game, nextSeat, om.planeId, d, style);
        if (v > oppBest) oppBest = v;
      }
    }
    if (oppBest > -Infinity) s -= oppBest * 0.4;
    if (s > best) best = s;
  }
  return best;
}

/** 一层前瞻：自己走后，折算下家 6 种骰子里最好一手对我的威胁（系数 k）。困难 k=0.25，大师 k=0.4。 */
function lookaheadScore(game, seat, planeId, dice, k, style) {
  const sim = applyMove(game, seat, planeId, dice);
  let s = scoreMove(game, seat, planeId, dice, style);
  const nextSeat = (seat + 1) % game.players.length;
  let oppBest = -Infinity;
  for (let d = 1; d <= 6; d += 1) {
    for (const om of computeLegalMoves(sim.game, nextSeat, d)) {
      const v = scoreMove(sim.game, nextSeat, om.planeId, d, style);
      if (v > oppBest) oppBest = v;
    }
  }
  if (oppBest > -Infinity) s -= oppBest * k;
  return s;
}

/**
 * 选择要移动的飞机。返回 planeId；无合法移动返回 null。
 * v13：从 game.players[seat].aiStyle 读取风格（aggressive/balanced/defensive），影响权重。
 */
function choosePlane(game, seat, dice, difficulty = 2) {
  const style = (game.players[seat] && game.players[seat].aiStyle) || 'balanced';
  const moves = computeLegalMoves(game, seat, dice);
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0].planeId;

  if (difficulty === 1) {
    // 简单：30% 概率选次优，故意放水
    const scored = moves.map((m) => ({ planeId: m.planeId, score: scoreMove(game, seat, m.planeId, dice, style) }));
    scored.sort((a, b) => b.score - a.score);
    if (Math.random() < 0.3 && scored.length > 1) return scored[1].planeId;
    return scored[0].planeId;
  }
  if (difficulty === 4) {
    // 大师：一层前瞻，深度权衡下家威胁（k=0.4）
    let bestId = moves[0].planeId, best = -Infinity;
    for (const m of moves) {
      const s = lookaheadScore(game, seat, m.planeId, dice, 0.4, style);
      if (s > best) { best = s; bestId = m.planeId; }
    }
    return bestId;
  }
  if (difficulty === 3) {
    // 困难：一层浅前瞻（k=0.25），能避开明显被吃，但比大师冒进
    let bestId = moves[0].planeId, best = -Infinity;
    for (const m of moves) {
      const s = lookaheadScore(game, seat, m.planeId, dice, 0.25, style);
      if (s > best) { best = s; bestId = m.planeId; }
    }
    return bestId;
  }
  // 普通：纯最高分，无前瞻
  const scored = moves.map((m) => ({ planeId: m.planeId, score: scoreMove(game, seat, m.planeId, dice, style) }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].planeId;
}

/**
 * v3 AI 主动用道具（炸弹/护盾）。在掷骰前由 playTurnAuto 调用，返回是否使用了道具。
 * 为避免与 game-controller 的循环依赖，这里直接对 game 做最小修改。
 */
function aiUseItems(game, seat, rng) {
  if (game.allowItems === false) return false;
  const inv = game.items && game.items[seat];
  if (!inv) return false;
  const me = game.players[seat];

  // 炸弹：找最靠前的敌方在途飞机（非安全格）炸回基地
  if (inv.bomb > 0) {
    let best = null, bestRp = -1;
    for (const other of game.players) {
      if (other.seat === seat) continue;
      for (const op of other.planes) {
        if (op.state === 'track' && op.rp > bestRp) {
          const abs = absCell(other.color, op.rp);
          if (!isSafeCell(abs)) { best = { seat: other.seat, planeId: op.id }; bestRp = op.rp; }
        }
      }
    }
    if (best) {
      const v = game.players[best.seat].planes.find((x) => x.id === best.planeId);
      v.rp = -1; v.state = 'base';
      game.players[best.seat].stats.beenKilled += 1;
      inv.bomb -= 1;
      game.seq += 1;
      return true;
    }
  }

  // 护盾：自己有在途飞机就挂盾保命
  if (inv.shield > 0) {
    const onTrack = me.planes.some((pl) => pl.state === 'track' || pl.state === 'lane');
    if (onTrack) {
      me.planes.forEach((pl) => {
        if ((pl.state === 'track' || pl.state === 'lane') && !pl.shield) pl.shield = true;
      });
      inv.shield -= 1;
      game.seq += 1;
      return true;
    }
  }
  return false;
}

module.exports = { choosePlane, aiUseItems, scoreMove, masterScore, WEIGHTS };
