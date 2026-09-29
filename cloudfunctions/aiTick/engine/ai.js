// [自动生成] 源文件 ../../miniprogram/engine/ai.js —— 请勿直接修改；改动请编辑源文件后运行 node tools/sync-engine.js
'use strict';

// ============================================================
// AI 启发式评分（架构文档第六节）—— 服务端 AI 回合与客户端演示共用
// 难度：1 简单（噪声+次优）/ 2 普通（纯最高分）/ 3 困难（一步前瞻）
// ============================================================

var rules = require('./rules.js');
var move = require('./move.js');

var WEIGHTS = {
  kill: 100,        // 撞子（按敌方进度加权）
  reachHome: 120,   // 直接到终点
  enterLane: 40,    // 进入归航道（安全区）
  takeOff: 35,      // 起飞
  landSafe: 20,     // 落安全格 / 己方航道
  stack: 15,        // 与己方叠子
  jumpGain: 2,      // 跳格每跳 1 格
  progress: 1.5,    // 每前进 1 格
  underdog: 10,     // 优先推进落后飞机
  riskPerDist: -30, // 落点被撞风险（按敌机距离衰减）
  masterPenalty: 0.4 // 大师档：下家期望收益的折算系数
};

// 敌机在 d 步内（沿其剩余航线）够到落点 → 最小威胁距离；否则 99。
// v1.3：增加「跳格击杀线」感知——敌机掷 j（1..6）落在己色格（不出航道口）跳 4
// 恰好到我落点，总直线距离可达 7-10 格，此前基础风险项对此失明。
function minThreatDist(state, seat, landingAbs) {
  var minD = 99;
  var target = ((landingAbs % rules.TRACK_LEN) + rules.TRACK_LEN) % rules.TRACK_LEN;
  for (var s = 0; s < state.players.length; s++) {
    if (s === seat) continue;
    var planes = state.players[s].planes;
    for (var i = 0; i < planes.length; i++) {
      var q = planes[i];
      if (q.state !== 'track') continue;
      var qAbs = rules.absOfRp(s, q.rp);
      var qRp = q.rp;
      // 直线击杀
      var d = (target - qAbs + rules.TRACK_LEN) % rules.TRACK_LEN;
      if (d >= 1 && d <= 6 && qRp + d <= 51 && d < minD) minD = d;
      // 跳格击杀：掷 j 落己色格 → 跳 4 → 恰为落点
      for (var j = 1; j <= 6; j++) {
        var midRp = qRp + j;
        if (midRp > 51) break; // j 再大也出航道口
        if (!rules.isOwnColor(s, midRp)) continue;
        if (midRp + 4 > 51) continue;
        var mAbs = (rules.absOfRp(s, midRp) + 4) % rules.TRACK_LEN;
        if (mAbs === target && j < minD) minD = j;
      }
    }
  }
  return minD;
}

function threatPenalty(state, seat, plan, weight) {
  if (!plan || plan.landsSafe || plan.finalState !== 'track') return 0;
  var d = minThreatDist(state, seat, plan.landingAbs);
  if (d > 6) return 0;
  return weight / d;
}

function evaluatePlan(state, seat, plan) {
  if (!plan) return -Infinity;
  var s = 0;
  var i;

  // v1.6：护盾抵消的击杀不计入收益；进攻带盾目标会遭反震（己方飞机回基地），重罚
  var realKills = 0;
  var anyBlocked = false;
  var bestVictimRp = 0;
  for (i = 0; i < plan.kills.length; i++) {
    if (plan.kills[i].blocked) { anyBlocked = true; continue; }
    realKills++;
    if (plan.kills[i].rp > bestVictimRp) bestVictimRp = plan.kills[i].rp;
  }
  if (realKills > 0) {
    s += WEIGHTS.kill * (1 + bestVictimRp / rules.HOME_RP);
  }
  if (anyBlocked) {
    s -= WEIGHTS.kill * (1 + Math.max(plan.from.rp, 0) / rules.HOME_RP);
  }
  if (plan.finished) s += WEIGHTS.reachHome;
  if (plan.entersLane) s += WEIGHTS.enterLane;
  if (plan.kind === 'takeoff') s += WEIGHTS.takeOff;
  if (plan.landsSafe) s += WEIGHTS.landSafe;
  if (plan.stackedWith.length > 0) s += WEIGHTS.stack;
  if (plan.fly !== null && plan.fly !== undefined) {
    s += rules.FLY_DIST * WEIGHTS.jumpGain; // 飞行箭头：一次跃 12 格
  } else if (plan.jump !== null && plan.jump !== undefined) {
    s += 4 * WEIGHTS.jumpGain;
  }

  var fromRp = plan.from.rp > 0 ? plan.from.rp : 0;
  s += (plan.finalRp - fromRp) * WEIGHTS.progress;
  s += (1 - Math.min(plan.finalRp, rules.HOME_RP) / rules.HOME_RP) * WEIGHTS.underdog;
  s += threatPenalty(state, seat, plan, WEIGHTS.riskPerDist);
  return s;
}

// 大师档（v1.2）：估算「我这步走完后，下家最优手的期望收益」。
// 单层期望（不对手再回推），能捕捉基础风险项看不到的威胁：
// 跳格延长的击杀线、起飞即成杀等。我方有奖励掷骰或已到终点时对手不会立即行动，收益记 0。
function expectedOpponentGain(state, seat, plan, dice) {
  if (!plan) return 0;
  if (plan.finished) return 0;
  if (dice === 6 || plan.kills.length > 0) return 0;
  const simState = move.cloneState(state);
  move.applyPlan(simState, plan);
  const nextSeat = (seat + 1) % simState.players.length;
  let total = 0;
  for (let d = 1; d <= 6; d++) {
    const movable = move.computeMovable(simState, nextSeat, d);
    let best = 0;
    for (const pid of movable) {
      const s = evaluatePlan(simState, nextSeat, move.planMove(simState, nextSeat, pid, d));
      if (s > best) best = s;
    }
    total += best;
  }
  return total / 6;
}

// v1.6：选机阶段是否值得重掷——持有重掷卡（普通以上档位）且当前所有候选期望为负
function wantsReroll(state, seat, dice, level) {
  if (level <= 1) return false;
  if (state.allowItems === false) return false;
  var it = state.items && state.items[seat];
  if (!it || it.reroll <= 0 || state.rerolledThisTurn) return false;
  var movable = move.computeMovable(state, seat, dice);
  if (movable.length === 0) return false;
  var best = -Infinity;
  for (var i = 0; i < movable.length; i++) {
    var s = evaluatePlan(state, seat, move.planMove(state, seat, movable[i], dice));
    if (s > best) best = s;
  }
  return best < 0;
}

function choosePlane(state, seat, dice, level, rng) {
  var movable = move.computeMovable(state, seat, dice);
  if (movable.length === 0) return null;

  var scored = [];
  for (var i = 0; i < movable.length; i++) {
    var plan = move.planMove(state, seat, movable[i], dice);
    scored.push({ planeId: movable[i], plan: plan, score: evaluatePlan(state, seat, plan) });
  }
  // 全部非法（理论兜底）
  var best0 = scored[0];
  if (best0.score === -Infinity) return movable[0];

  scored.sort(function (a, b) { return b.score - a.score; });

  if (level >= 4) {
    // 大师：基础分减去下家期望收益的折算，再取最高
    for (var k = 0; k < scored.length; k++) {
      scored[k].score -= WEIGHTS.masterPenalty *
        expectedOpponentGain(state, seat, scored[k].plan, dice);
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored[0].planeId;
  }

  if (level >= 3) {
    // 困难：25% 概率做一步前瞻复核，加重被撞顾虑
    if (rng() < 0.25) {
      for (var k = 0; k < scored.length; k++) {
        scored[k].score += threatPenalty(state, seat, scored[k].plan, -18);
      }
      scored.sort(function (a, b) { return b.score - a.score; });
    }
    return scored[0].planeId;
  }

  if (level <= 1) {
    // 简单：±40 噪声，30% 概率选次优
    for (var m = 0; m < scored.length; m++) {
      scored[m].score += (rng() * 2 - 1) * 40;
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    if (scored.length > 1 && rng() < 0.3) return scored[1].planeId;
    return scored[0].planeId;
  }

  return scored[0].planeId; // 普通：纯最高分
}

module.exports = {
  WEIGHTS: WEIGHTS,
  evaluatePlan: evaluatePlan,
  expectedOpponentGain: expectedOpponentGain,
  wantsReroll: wantsReroll,
  choosePlane: choosePlane
};
