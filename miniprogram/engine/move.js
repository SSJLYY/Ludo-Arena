'use strict';

// ============================================================
// 单步结算：可动计算 / 落点规划 / 状态推进 —— 纯函数，不含任何 IO
// 云函数用 applyPlan 做权威结算，客户端用 planMove.path 做预测动画，
// 两端跑同一套代码（架构文档第二节的关键设计）。
// ============================================================

var rules = require('./rules.js');

// —— 状态克隆（字段白名单，比 JSON 往返快一个量级；模拟 1000 局时明显）——
function cloneState(s) {
  return {
    roomId: s.roomId,
    status: s.status,
    seq: s.seq,
    currentSeat: s.currentSeat,
    phase: s.phase,
    dice: s.dice,
    diceHistory: s.diceHistory.slice(),
    extraRollLeft: s.extraRollLeft,
    consecutiveSix: s.consecutiveSix,
    needExactFinish: s.needExactFinish,
    allowJump: s.allowJump,
    allowFly: s.allowFly,
    allowItems: s.allowItems,
    items: s.items.map(function (it) {
      return { shield: it.shield, reroll: it.reroll };
    }),
    rerolledThisTurn: s.rerolledThisTurn,
    movablePlanes: s.movablePlanes.slice(),
    players: s.players.map(function (p) {
      return {
        seat: p.seat,
        color: p.color,
        type: p.type,
        openId: p.openId,
        nickName: p.nickName,
        avatarUrl: p.avatarUrl,
        planes: p.planes.map(function (pl) {
          return { id: pl.id, state: pl.state, rp: pl.rp, shield: !!pl.shield };
        }),
        finishedCount: p.finishedCount,
        finishRank: p.finishRank,
        stats: {
          rolls: p.stats.rolls,
          kills: p.stats.kills,
          beenKilled: p.stats.beenKilled,
          sixes: p.stats.sixes
        }
      };
    }),
    events: [],
    finishCounter: s.finishCounter,
    winner: s.winner,
    ranking: s.ranking.slice(),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt
  };
}

// 由房间座位创建一局新对局（gameStart 云函数调用）
function createGame(opts) {
  var seats = opts.seats;
  return {
    roomId: opts.roomId || '',
    status: 'playing',          // playing | finished
    seq: 0,
    currentSeat: 0,
    phase: 'rolling',           // rolling | selecting | ended
    dice: 0,
    diceHistory: [],
    extraRollLeft: 0,
    consecutiveSix: 0,
    needExactFinish: opts.needExactFinish !== false,
    allowJump: opts.allowJump !== false,
    allowFly: opts.allowFly !== false,
    allowItems: opts.allowItems !== false,
    items: [{ shield: 0, reroll: 0 }, { shield: 0, reroll: 0 }, { shield: 0, reroll: 0 }, { shield: 0, reroll: 0 }],
    rerolledThisTurn: false,
    movablePlanes: [],
    players: seats.map(function (s, i) {
      return {
        seat: i,
        color: rules.COLORS[i],
        type: s.type,
        openId: s.openId || '',
        nickName: s.nickName || '',
        avatarUrl: s.avatarUrl || '',
        planes: [0, 1, 2, 3].map(function (id) {
          return { id: id, state: 'base', rp: rules.BASE_RP, shield: false };
        }),
        finishedCount: 0,
        finishRank: null,
        stats: { rolls: 0, kills: 0, beenKilled: 0, sixes: 0 }
      };
    }),
    events: [],
    finishCounter: 0,
    winner: null,
    ranking: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function stateOfRp(rp) {
  if (rp === rules.BASE_RP) return 'base';
  if (rp >= rules.HOME_RP) return 'home';
  if (rp >= rules.LANE_START) return 'lane';
  return 'track';
}

// 归一化落点：主环用绝对格位（跨座位可比），归航道用 (seat, idx)
function pointOfRp(seat, rp) {
  if (rp >= 0 && rp <= 51) return { zone: 'track', abs: rules.absOfRp(seat, rp) };
  if (rp >= rules.LANE_START && rp < rules.HOME_RP) {
    return { zone: 'lane', seat: seat, idx: rp - rules.LANE_START };
  }
  return { zone: 'home', seat: seat };
}

// 落在 abs 上的所有敌机（撞子目标）
function enemiesAtAbs(state, moverSeat, abs) {
  var out = [];
  for (var s = 0; s < state.players.length; s++) {
    if (s === moverSeat) continue;
    var planes = state.players[s].planes;
    for (var i = 0; i < planes.length; i++) {
      var p = planes[i];
      if (p.state === 'track' && rules.absOfRp(s, p.rp) === rules.normalizeAbs(abs)) {
        out.push({ seat: s, planeId: p.id, rp: p.rp });
      }
    }
  }
  return out;
}

// 跳格 / 飞行箭头（v1.1）：落己色格时——
//   箭头格（rp 36）且 allowFly → 沿航线飞跃 12 格至 rp 48；
//   否则跳到下一个同色格（+4）。
// 裁定：不连锁（一次落定只触发一次）；跳格若 +4 会越过归航道口（rp+4 > 51）则不跳。
function planHop(state, seat, rp) {
  if (rp < 0 || rp > 51) return null;
  if (!rules.isOwnColor(seat, rp)) return null;
  if (state.allowFly !== false && rp === rules.FLY_RP) {
    return { type: 'fly', target: rp + rules.FLY_DIST }; // 48，恒在主环内
  }
  if (state.allowJump === false) return null;
  if (rp + 4 > 51) return null;
  return { type: 'jump', target: rp + 4 };
}

// 当前骰子下哪些飞机可动
function computeMovable(state, seat, dice) {
  var out = [];
  var planes = state.players[seat].planes;
  for (var i = 0; i < planes.length; i++) {
    var p = planes[i];
    if (p.state === 'base') {
      if (dice === 6) out.push(p.id);
      continue;
    }
    if (p.state === 'home') continue;
    var target = p.rp + dice;
    if (target <= rules.HOME_RP) {
      out.push(p.id);
    } else if (!state.needExactFinish) {
      out.push(p.id); // 弹回模式：超出终点往回弹
    }
  }
  return out;
}

// 规划一次移动（不改状态）：路径、跳格、撞子、叠子、进港/到终点
function planMove(state, seat, planeId, dice) {
  var player = state.players[seat];
  var plane = player.planes[planeId];
  if (!plane) return null;

  var i, r;
  var path = [];        // 逐格 rp 路径（动画按格跳；飞跃为一次长跳）
  var jump = null;
  var fly = null;
  var hop = null;
  var bounce = false;
  var kind = 'move';
  var from = { state: plane.state, rp: plane.rp };
  var target, finalRp;

  if (plane.state === 'base') {
    if (dice !== 6) return null;
    kind = 'takeoff';
    path.push(0);
    hop = planHop(state, seat, 0);
    if (hop !== null) path.push(hop.target);
    finalRp = path[path.length - 1];
  } else if (plane.state === 'home') {
    return null;
  } else {
    target = plane.rp + dice;
    if (target > rules.HOME_RP) {
      if (state.needExactFinish) return null; // 精确到达：超出不能动
      bounce = true;
      kind = 'bounce';
      target = 2 * rules.HOME_RP - target;    // 弹回：114 - rp - dice，必落在归航道内
      for (r = plane.rp + 1; r <= rules.HOME_RP; r++) path.push(r);
      for (r = rules.HOME_RP - 1; r >= target; r--) path.push(r);
      finalRp = target;
    } else {
      for (r = plane.rp + 1; r <= target; r++) path.push(r);
      if (target <= 51) {
        hop = planHop(state, seat, target);
        if (hop !== null) path.push(hop.target);
      }
      finalRp = path[path.length - 1];
      if (plane.rp <= 51 && finalRp >= rules.LANE_START && finalRp < rules.HOME_RP) kind = 'lane';
    }
  }

  var fpt = pointOfRp(seat, finalRp);
  // 撞子判定只在最终落点：安全格不撞；归航道/终点无敌人
  // v1.6：目标带护盾 → blocked=true（执行时抵消，不回基地）
  var kills = (fpt.zone === 'track' && !rules.isSafeAbs(fpt.abs))
    ? enemiesAtAbs(state, seat, fpt.abs)
    : [];
  for (i = 0; i < kills.length; i++) {
    var vk = state.players[kills[i].seat].planes[kills[i].planeId];
    kills[i].blocked = !!vk.shield;
  }

  // 叠子显示：同座位其它飞机已在同一落点
  var stackedWith = [];
  var planes = player.planes;
  for (i = 0; i < planes.length; i++) {
    var q = planes[i];
    if (q.id === planeId || q.state === 'base' || q.state === 'home') continue;
    var qp = pointOfRp(seat, q.rp);
    if (qp.zone === fpt.zone && fpt.zone !== 'home' &&
      (qp.zone === 'lane' ? qp.idx === fpt.idx : qp.abs === fpt.abs)) {
      stackedWith.push(q.id);
    }
  }

  return {
    seat: seat,
    planeId: planeId,
    kind: kind,
    from: from,
    path: path,
    jump: hop && hop.type === 'jump' ? hop.target : null,
    fly: hop && hop.type === 'fly' ? hop.target : null,
    bounce: bounce,
    finalRp: finalRp,
    finalState: stateOfRp(finalRp),
    landingAbs: fpt.zone === 'track' ? fpt.abs : null,
    kills: kills,
    stackedWith: stackedWith,
    entersLane: from.state === 'track' && finalRp >= rules.LANE_START && finalRp < rules.HOME_RP,
    landsSafe: fpt.zone === 'lane' || (fpt.zone === 'track' && rules.isSafeAbs(fpt.abs)),
    finished: finalRp === rules.HOME_RP
  };
}

// 执行规划（改状态），返回 move 事件（供 lastAction/动画/流水）
function applyPlan(state, plan) {
  var player = state.players[plan.seat];
  var plane = player.planes[plan.planeId];
  plane.state = plan.finalState;
  plane.rp = plan.finalRp;

  if (plan.finished) {
    player.finishedCount += 1;
    // finishRank 记录「玩家完成全部 4 机」的先后（先完成者胜）
    if (player.finishedCount === 4) {
      state.finishCounter += 1;
      player.finishRank = state.finishCounter;
    }
  }

  var killed = [];
  var realKills = 0;
  var anyBlocked = false;
  for (var i = 0; i < plan.kills.length; i++) {
    var k = plan.kills[i];
    var victim = state.players[k.seat];
    var vplane = victim.planes[k.planeId];
    if (vplane.shield) {
      // v1.6 护盾反震：护盾消耗挡下击杀，目标不回基地，进攻方飞机反被撞回基地
      vplane.shield = false;
      killed.push({ seat: k.seat, planeId: k.planeId, abs: plan.landingAbs, blocked: true });
      anyBlocked = true;
    } else {
      vplane.state = 'base';
      vplane.rp = rules.BASE_RP;
      victim.stats.beenKilled += 1;
      player.stats.kills += 1;
      realKills += 1;
      killed.push({ seat: k.seat, planeId: k.planeId, abs: plan.landingAbs, blocked: false });
    }
  }
  if (anyBlocked) {
    plane.state = 'base';
    plane.rp = rules.BASE_RP;
    player.stats.beenKilled += 1;
  }

  var ev = {
    type: 'move',
    seat: plan.seat,
    planeId: plan.planeId,
    kind: plan.kind,
    from: plan.from,
    to: { state: plan.finalState, rp: plan.finalRp },
    path: plan.path,
    jump: plan.jump,
    fly: plan.fly,
    bounce: plan.bounce,
    kills: killed,
    stackedWith: plan.stackedWith,
    finished: !!plan.finished
  };

  if (player.finishedCount === 4) {
    state.status = 'finished';
    state.phase = 'ended';
    state.winner = plan.seat;
    state.ranking = buildRanking(state, plan.seat);
    state.movablePlanes = [];
    ev.win = true;
    ev.ranking = state.ranking;
  }
  return ev;
}

// 玩家总进度（基地 0 分；用于未完成者的名次排序）
function progressOf(player) {
  var sum = 0;
  for (var i = 0; i < player.planes.length; i++) {
    var p = player.planes[i];
    sum += p.state === 'base' ? 0 : p.rp;
  }
  return sum;
}

function buildRanking(state, winnerSeat) {
  var rest = [];
  for (var s = 0; s < state.players.length; s++) {
    if (s !== winnerSeat) rest.push(state.players[s]);
  }
  rest.sort(function (a, b) {
    var d = progressOf(b) - progressOf(a);
    if (d !== 0) return d;
    d = b.finishedCount - a.finishedCount;
    if (d !== 0) return d;
    return a.seat - b.seat;
  });
  return [winnerSeat].concat(rest.map(function (p) { return p.seat; }));
}

// 真实击杀数（护盾抵消的不计）——决定撞子奖励掷骰
function realKillCount(plan) {
  var n = 0;
  for (var i = 0; i < plan.kills.length; i++) {
    if (!plan.kills[i].blocked) n++;
  }
  return n;
}

module.exports = {
  cloneState: cloneState,
  createGame: createGame,
  stateOfRp: stateOfRp,
  pointOfRp: pointOfRp,
  enemiesAtAbs: enemiesAtAbs,
  planHop: planHop,
  computeMovable: computeMovable,
  planMove: planMove,
  applyPlan: applyPlan,
  realKillCount: realKillCount,
  progressOf: progressOf,
  buildRanking: buildRanking
};
