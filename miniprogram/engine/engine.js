'use strict';

// ============================================================
// 回合状态机（服务端权威）：advance 处理一次掷骰/选机，
// runAiTurn 在一次调用内跑完一个 AI/托管座位的整回合。
// 全部纯函数：输入快照 → 输出新快照 + 事件流。
// ============================================================

var rules = require('./rules.js');
var move = require('./move.js');
var ai = require('./ai.js');

function rollDice(rng) {
  return 1 + Math.floor(rng() * 6);
}

// 换下一座位行动
function passTurn(st) {
  st.currentSeat = (st.currentSeat + 1) % st.players.length;
  st.phase = 'rolling';
  st.consecutiveSix = 0;
  st.extraRollLeft = 0;
  st.rerolledThisTurn = false;
  st.movablePlanes = [];
}

// 移动结算后的回合裁决：掷 6 或真实撞子 → 同人再掷；否则换人。
// reroll 场景 noDiceExtra=true：重掷出的点数不再触发掷 6 奖励（击杀奖励保留）。
function finishTurnAfterMove(st, dice, killedSomething, noDiceExtra) {
  if (st.status !== 'playing') return; // 本手分出胜负
  var extra = (dice === 6 && !noDiceExtra) || killedSomething;
  st.extraRollLeft = extra ? 1 : 0;
  if (extra) {
    st.phase = 'rolling';
    st.movablePlanes = [];
  } else {
    passTurn(st);
  }
}

// v1.6 道具卡：命中敌机即得卡（护盾被抵消也算进攻成功）。上限各 1 张。
// 护盾自动挂到最靠前的己方轨道飞机；无轨道机则降级为重掷卡。
function grantItem(st, seat, events, rng) {
  if (st.allowItems === false) return;
  var items = st.items[seat];
  var canShield = items.shield < 1;
  var canReroll = items.reroll < 1;
  if (!canShield && !canReroll) return;
  var type = rng() < 0.5 ? 'shield' : 'reroll';
  if (type === 'shield' && !canShield) type = 'reroll';
  if (type === 'reroll' && !canReroll) type = 'shield';
  if (type === 'shield') {
    var best = -1;
    var bestRp = -1;
    var planes = st.players[seat].planes;
    for (var i = 0; i < planes.length; i++) {
      var pl = planes[i];
      if (pl.state === 'track' && !pl.shield && pl.rp > bestRp) {
        bestRp = pl.rp;
        best = pl.id;
      }
    }
    if (best < 0) {
      type = 'reroll'; // 无轨道机可挂 → 降级
    } else {
      planes[best].shield = true;
      items.shield = 1;
      events.push({ type: 'gain_item', seat: seat, item: 'shield', planeId: best });
      return;
    }
  }
  items.reroll = 1;
  events.push({ type: 'gain_item', seat: seat, item: 'reroll' });
}

// 执行一个动作。返回 { ok, state, events } 或 { ok:false, error }
function advance(prev, action, rng) {
  var st = move.cloneState(prev);
  if (st.status !== 'playing') return { ok: false, error: 'GAME_ENDED' };
  if (!action || action.seat !== st.currentSeat) return { ok: false, error: 'NOT_YOUR_TURN' };
  var seat = action.seat;
  var events = [];

  // ---- 掷骰 ----
  if (action.type === 'ROLL') {
    if (st.phase !== 'rolling') return { ok: false, error: 'ILLEGAL_ACTION' };
    var dice = rollDice(rng);
    var player = st.players[seat];
    player.stats.rolls += 1;
    st.dice = dice;
    st.diceHistory.push(dice);
    if (st.diceHistory.length > 500) st.diceHistory = st.diceHistory.slice(-400);
    events.push({ type: 'roll', seat: seat, dice: dice });

    if (dice === 6) {
      player.stats.sixes += 1;
      st.consecutiveSix += 1;
      if (st.consecutiveSix >= rules.MAX_SIX_STREAK) {
        // 连掷第 3 个 6：本回合作废（本手不动），直接换人
        events.push({ type: 'void', seat: seat });
        passTurn(st);
        st.events = events;
        return { ok: true, state: st, events: events };
      }
    } else {
      st.consecutiveSix = 0;
    }

    var movable = move.computeMovable(st, seat, dice);
    if (movable.length === 0) {
      // 无子可动：自动跳过（裁定：即便掷 6 也不保留额外掷骰）
      events.push({ type: 'skip', seat: seat });
      passTurn(st);
      st.events = events;
      return { ok: true, state: st, events: events };
    }
    if (movable.length === 1) {
      // 唯一可动：自动执行，省一次点击（架构文档 6.3）
      var plan0 = move.planMove(st, seat, movable[0], dice);
      events.push(move.applyPlan(st, plan0));
      if (plan0.kills.length > 0) grantItem(st, seat, events, rng); // 命中敌机才得卡
      finishTurnAfterMove(st, dice, move.realKillCount(plan0) > 0);
      st.events = events;
      return { ok: true, state: st, events: events };
    }
    st.phase = 'selecting';
    st.movablePlanes = movable;
    st.events = events;
    return { ok: true, state: st, events: events };
  }

  // ---- 道具：重掷（v1.6，选机阶段使用，每回合一次，不计连六/不触发掷 6 奖励） ----
  if (action.type === 'USE_ITEM') {
    if (st.phase !== 'selecting') return { ok: false, error: 'ILLEGAL_ACTION' };
    if (action.item !== 'reroll' || st.allowItems === false) {
      return { ok: false, error: 'ILLEGAL_ACTION' };
    }
    if (st.items[seat].reroll <= 0 || st.rerolledThisTurn) {
      return { ok: false, error: 'NO_ITEM' };
    }
    var prevDice = st.dice;
    var newDice = rollDice(rng);
    st.dice = newDice;
    st.diceHistory.push(newDice);
    if (st.diceHistory.length > 500) st.diceHistory = st.diceHistory.slice(-400);
    st.items[seat].reroll -= 1;
    st.rerolledThisTurn = true;
    events.push({ type: 'reroll', seat: seat, prevDice: prevDice, dice: newDice });

    var movableR = move.computeMovable(st, seat, newDice);
    if (movableR.length === 0) {
      events.push({ type: 'skip', seat: seat });
      passTurn(st);
      st.events = events;
      return { ok: true, state: st, events: events };
    }
    if (movableR.length === 1) {
      var planR = move.planMove(st, seat, movableR[0], newDice);
      events.push(move.applyPlan(st, planR));
      if (planR.kills.length > 0) grantItem(st, seat, events, rng); // 命中敌机才得卡
      finishTurnAfterMove(st, newDice, move.realKillCount(planR) > 0, true);
      st.events = events;
      return { ok: true, state: st, events: events };
    }
    st.phase = 'selecting';
    st.movablePlanes = movableR;
    st.events = events;
    return { ok: true, state: st, events: events };
  }

  // ---- 选飞机 ----
  if (action.type === 'SELECT_PLANE') {
    if (st.phase !== 'selecting') return { ok: false, error: 'ILLEGAL_ACTION' };
    if (st.movablePlanes.indexOf(action.planeId) < 0) {
      return { ok: false, error: 'PLANE_NOT_MOVABLE' };
    }
    var plan = move.planMove(st, seat, action.planeId, st.dice);
    if (!plan) return { ok: false, error: 'PLANE_NOT_MOVABLE' };
    events.push(move.applyPlan(st, plan));
    st.movablePlanes = [];
    if (plan.kills.length > 0) grantItem(st, seat, events, rng); // 命中敌机才得卡
    finishTurnAfterMove(st, st.dice, move.realKillCount(plan) > 0);
    st.events = events;
    return { ok: true, state: st, events: events };
  }

  return { ok: false, error: 'UNKNOWN_ACTION' };
}

// 跑完当前座位（AI 或掉线托管）的整回合，返回若干步 { state, events }。
// 每步对应一次快照写入（seq 各 +1），客户端按事件队列依次播动画。
// CAS 冲突时云函数中断即可：AI 行动可从任意快照安全重入。
function runAiTurn(prev, rng, levelFor) {
  var steps = [];
  var cur = prev;
  for (var i = 0; i < 12; i++) {
    if (cur.status !== 'playing') break;
    var seat = cur.currentSeat;
    var r1 = advance(cur, { type: 'ROLL', seat: seat }, rng);
    if (!r1.ok) break;
    steps.push(r1);
    cur = r1.state;
    if (cur.status !== 'playing') break;

    if (cur.phase === 'selecting') {
      // v1.6 普通以上档位：候选质量差且持有重掷卡时先重掷
      if (ai.wantsReroll(cur, seat, cur.dice, levelFor(seat), rng)) {
        var r0 = advance(cur, { type: 'USE_ITEM', seat: seat, item: 'reroll' }, rng);
        if (r0.ok) {
          steps.push(r0);
          cur = r0.state;
        }
      }
      if (cur.status === 'playing' && cur.phase === 'selecting') {
        var pid = ai.choosePlane(cur, seat, cur.dice, levelFor(seat), rng);
        if (pid === null || pid === undefined) break;
        var r2 = advance(cur, { type: 'SELECT_PLANE', seat: seat, planeId: pid }, rng);
        if (!r2.ok) break;
        steps.push(r2);
        cur = r2.state;
      }
    }

    // 额外掷骰仍归本座位 → 继续本回合；已换人则结束本次调用
    if (!(cur.status === 'playing' && cur.currentSeat === seat)) break;
    if (cur.phase !== 'rolling') break;
  }
  return steps;
}

module.exports = {
  rollDice: rollDice,
  advance: advance,
  runAiTurn: runAiTurn
};
