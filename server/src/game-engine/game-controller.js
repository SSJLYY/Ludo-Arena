/**
 * game-controller.js — 回合流转控制器（纯逻辑，前后端共用）
 *
 * v2.0 新增（移植小程序版）：
 *   - 房间设置透传：allowFly（飞行箭头）/ allowItems（道具卡）/ needExactFinish（精确到达）
 *   - reroll：选机阶段用重掷卡重掷一次（每回合一次，不计连六、不触发掷 6 奖励）
 *   - AI 自动重掷（playTurnAuto 内）
 *
 * v10 多骰模式（diceCount 1/2/3）：
 *   - 一次掷出 N 颗骰子放进 game.diceList 队列，玩家**逐颗使用**
 *     （可分给不同飞机，也可同一架连走），用完一整组才算一个回合结束。
 *   - game.dice 恒等于「当前正在用的那颗」，game.diceIndex 是它的下标。
 *     单骰模式下行为与 v1 完全一致（diceList 长度 1），老逻辑零回归。
 *   - 多骰模式平衡裁定：6 与起飞**不再**奖励额外投掷（本组点数已够多），
 *     仅「击落敌机」奖励再掷一整组；连续奖励上限 MAX_EXTRA_SIX，防死循环。
 *   - 连六作废（第 3 个 6 换人）只在单骰模式生效——多骰没有 6 的额外投掷，
 *     不存在无限连掷，无需作废；整组全 6 仅计入统计。
 */

const { COLORS, PLANES_PER_PLAYER, MAX_EXTRA_SIX, FINISH_RP, absCell, isSafeCell } = require('./rules');
const { computeLegalMoves, applyMove } = require('./move');
const { choosePlane, aiUseItems } = require('./ai');

/**
 * @param {Array} seatConfigs [{ type, aiLevel }]
 * @param {object} opts 房间设置 { needExactFinish, allowJump, allowFly, allowItems }
 */
function createGame(seatConfigs, opts = {}) {
  const teamMode = !!opts.teamMode;
  const players = seatConfigs.map((cfg, i) => ({
    seat: i,
    color: COLORS[i],
    type: cfg.type || 'ai',
    aiLevel: cfg.aiLevel || 2,
    // v13 托管/AI 风格：aggressive/balanced/defensive（前端选 AI 难度时连带设定）
    aiStyle: (cfg.hostStyle && ['aggressive', 'balanced', 'defensive'].includes(cfg.hostStyle))
      ? cfg.hostStyle : 'balanced',
    // v8 团队赛：teamMode 下座位 0/1 为红队、2/3 为蓝队，否则不分组
    team: teamMode ? Math.floor(i / 2) : null,
    planes: Array.from({ length: PLANES_PER_PLAYER }, (_, id) => ({
      id, state: 'base', rp: -1, shield: false,
    })),
    finishedCount: 0,
    finishRank: null,
    stats: { rolls: 0, kills: 0, beenKilled: 0, sixes: 0 },
  }));
  return {
    seq: 0,
    currentSeat: 0,
    phase: 'rolling',
    teamMode, // v8 2v2 团队赛开关（默认 false，单人对局逻辑完全不变）
    winnerTeam: null, // 团队赛获胜队伍（0 红 / 1 蓝）
    dice: 0,
    diceHistory: [],
    consecutiveSix: 0,
    extraRollLeft: 0,
    roundNo: 0, // v13 回合计数（switchPlayer 自增），用于 roundLimit 超时判胜
    // —— v10 多骰模式 ——（房间设置用 diceMode 这个名，这里两种写法都认）
    diceCount: (function (v) {
      const n = Number(v === undefined || v === null ? 1 : v);
      return n === 2 || n === 3 ? n : 1;
    }(opts.diceCount !== undefined ? opts.diceCount : opts.diceMode)),
    diceList: [],       // 本组骰子 [d1, d2, d3]
    diceIndex: 0,       // 当前正在用的那颗的下标
    rollStreak: 0,      // 连续「额外再掷一组」的次数（上限 MAX_EXTRA_SIX）
    turnExtraRoll: false, // 本组是否已攒到额外投掷资格（击落/6/起飞）
    // —— v2.0 设置与道具 ——
    needExactFinish: opts.needExactFinish !== false,
    allowJump: opts.allowJump !== false,
    allowFly: opts.allowFly !== false,
    allowItems: opts.allowItems !== false,
    // —— v13 自定义规则 ——
    takeoffAny: !!opts.takeoffAny,  // 任意点数可起飞
    crashBack: opts.crashBack !== false, // 撞子回基地（默认 true）
    roundLimit: Number(opts.roundLimit) || 0, // 回合上限（0=不限）
    items: [0, 1, 2, 3].map(() => ({ bomb: 0, shield: 0, accel: 0, swap: 0 })),
    itemCells: [6, 19, 32, 45].reduce((m, a) => { m[a] = 0; return m; }, {}),
    players,
    movablePlanes: [],
    winner: null,
    ranking: [],
    createdAt: Date.now(),
  };
}

// v13 极速模式：达到回合上限时按各机进度判胜（团队赛按队伍总进度）
function endByRoundLimit(game) {
  const planeProg = (seat) => game.players[seat].planes.reduce((s, pl) => s + (pl.rp >= 0 ? pl.rp : 0), 0);
  if (game.teamMode) {
    const teamProg = [0, 1].map((t) => ({
      t,
      sum: game.players.reduce((s, p, idx) => s + (p.team === t ? planeProg(idx) : 0), 0),
    }));
    teamProg.sort((a, b) => b.sum - a.sum);
    game.winnerTeam = teamProg[0].t;
    game.winner = teamProg[0].t;
    game.ranking = teamProg.map((x) => x.t);
  } else {
    const seats = game.players.map((p, seat) => ({ seat, sum: planeProg(seat) }));
    seats.sort((a, b) => b.sum - a.sum);
    game.winner = seats[0].seat;
    game.ranking = seats.map((x) => x.seat);
  }
  game.phase = 'ended';
}

function switchPlayer(game) {
  game.currentSeat = (game.currentSeat + 1) % game.players.length;
  game.phase = 'rolling';
  game.roundNo = (Number(game.roundNo) || 0) + 1; // v13 回合计数（用于 roundLimit）
  game.consecutiveSix = 0;
  game.dice = 0;
  game.movablePlanes = [];
  // v10：换人时清空骰子队列，下一回合重新掷一整组
  game.diceList = [];
  game.diceIndex = 0;
  game.turnExtraRoll = false;
  // v3 道具格冷却递减（按回合）
  if (game.itemCells) {
    Object.keys(game.itemCells).forEach((k) => {
      if (game.itemCells[k] > 0) game.itemCells[k] -= 1;
    });
  }
  // v13 极速模式：回合上限到达 → 按进度判胜
  if (game.roundLimit > 0 && game.roundNo >= game.roundLimit && game.ranking.length === 0) {
    endByRoundLimit(game);
  }
}

/**
 * v10：本房间一回合掷几颗骰子（1 = 经典单骰，2/3 = 多骰狂野）。
 */
function diceCountOf(game) {
  const n = Number(game.diceCount);
  return n === 2 || n === 3 ? n : 1;
}

function isGameOver(game) {
  return game.ranking.length > 0;
}

/**
 * 掷一组骰子。rng 为 () => 1..6 的随机函数。
 * 单骰模式等价于老 roll()；多骰模式一次掷 N 颗，放入 diceList 队列逐颗使用。
 * 返回 { game, legal, dice, pending, voided?, skipped? }。
 *   pending = 本组里「待使用」的剩余颗数（不含当前这颗）。
 */
function roll(game, seat, rng) {
  if (game.phase === 'ended') return { game, legal: [], dice: 0 };
  if (seat !== game.currentSeat) return { game, legal: [], dice: 0 };

  const n = diceCountOf(game);
  const list = [];
  for (let i = 0; i < n; i += 1) list.push(rng());

  game.diceList = list;
  game.diceIndex = 0;
  game.turnExtraRoll = false;
  list.forEach((d) => {
    game.diceHistory.push(d);
    if (d === 6) game.players[seat].stats.sixes += 1;
  });
  if (game.diceHistory.length > 500) game.diceHistory = game.diceHistory.slice(-400);
  game.players[seat].stats.rolls += 1;

  // 连 6 作废只在经典单骰模式生效：多骰没有「掷 6 再掷一次」，不存在无限连掷
  if (n === 1) {
    if (list[0] === 6) {
      game.consecutiveSix += 1;
      if (game.consecutiveSix >= MAX_EXTRA_SIX) {
        switchPlayer(game);
        game.seq += 1;
        return { game, legal: [], dice: list[0], voided: true };
      }
    } else {
      game.consecutiveSix = 0;
    }
  } else if (list.every((d) => d === 6)) {
    game.consecutiveSix += 1; // 整组全 6 仅作统计，不作废
  } else {
    game.consecutiveSix = 0;
  }

  return Object.assign({ game }, advanceDice(game, seat));
}

/**
 * v10 推进到下一颗「有棋可走」的骰子。
 *  - 找到 → phase=selecting，返回该颗的 legal 与剩余 pending
 *  - 一整组用完/都无解 → 结算回合（额外再掷一组 or 换人），返回 legal=[]
 */
function advanceDice(game, seat) {
  const list = Array.isArray(game.diceList) ? game.diceList : [];
  while (game.diceIndex < list.length) {
    const d = list[game.diceIndex];
    const legal = computeLegalMoves(game, seat, d);
    if (legal.length) {
      game.dice = d;
      game.phase = 'selecting';
      game.movablePlanes = legal.map((m) => m.planeId);
      game.seq += 1;
      return { legal, dice: d, pending: list.length - game.diceIndex - 1 };
    }
    game.diceIndex += 1; // 这颗无子可走 → 弃掉，试下一颗
  }
  const extraRoll = finishTurn(game);
  return { legal: [], dice: game.dice, pending: 0, extraRoll, turnEnd: true, skipped: !extraRoll };
}

/**
 * v10 一整组骰子用完 → 判定是否额外再掷一组，否则换人。
 *  - 经典单骰：掷 6 / 起飞 / 击落 都奖励（沿用 v1 规则），连六上限 3
 *  - 多骰狂野：6 与起飞不再奖励（本组点数已经够多），仅「击落敌机」奖励
 *  - 两种模式共用 rollStreak 上限，防止无限连投
 */
function finishTurn(game) {
  const multi = diceCountOf(game) > 1;
  const extra = !!game.turnExtraRoll
    && (multi ? game.rollStreak < MAX_EXTRA_SIX : game.consecutiveSix < MAX_EXTRA_SIX);

  if (extra) {
    game.rollStreak += 1;
    game.phase = 'rolling';
    game.dice = 0;
    game.diceList = [];
    game.diceIndex = 0;
    game.movablePlanes = [];
    game.turnExtraRoll = false;
    game.seq += 1;
    return true;
  }

  game.rollStreak = 0;
  switchPlayer(game);
  game.seq += 1;
  return false;
}

/**
 * v3 使用道具（主动）。可在自己回合的 rolling / selecting 阶段使用，不消耗骰子回合。
 * @param {string} item 'bomb' | 'shield' | 'accel' | 'swap'
 * @param {object} payload
 *   bomb/accel: { target: { seat, planeId } }
 *   swap:       { targets: [ {seat,planeId}, {seat,planeId} ] }
 *   shield:     无需 target
 * 返回 { game, events, ok }（ok=false 表示非法使用，game 不变）。
 */
function useItem(game, seat, item, payload, rng) {
  rng = rng || Math.random;
  const fail = { game, events: [], ok: false };
  if (game.phase === 'ended') return fail;
  if (seat !== game.currentSeat) return fail;
  if (game.allowItems === false) return fail;
  const inv = game.items && game.items[seat];
  if (!inv || !inv[item] || inv[item] <= 0) return fail;
  const events = [];

  if (item === 'shield') {
    // 给所有在途飞机挂护盾（被动防护，已被撞则消耗），无在途机则不可用
    const p = game.players[seat];
    let any = false;
    p.planes.forEach((pl) => {
      if ((pl.state === 'track' || pl.state === 'lane') && !pl.shield) { pl.shield = true; any = true; }
    });
    if (!any) return fail;
    inv.shield -= 1;
    events.push({ type: 'use_item', seat, item: 'shield' });
  } else if (item === 'bomb') {
    // 炸毁敌方一架在跑道上的飞机（安全格免疫）
    const t = payload && payload.target;
    if (!t) return fail;
    const victimSeat = game.players[t.seat];
    const victim = victimSeat && victimSeat.planes.find((x) => x.id === t.planeId);
    if (!victim || victim.state !== 'track') return fail;
    const abs = absCell(victimSeat.color, victim.rp);
    if (isSafeCell(abs)) return fail;
    victim.rp = -1; victim.state = 'base';
    victimSeat.stats.beenKilled += 1;
    inv.bomb -= 1;
    events.push({ type: 'bomb', seat, item: 'bomb', victimSeat: t.seat, victimPlaneId: t.planeId });
  } else if (item === 'accel') {
    // 选自己一架在途飞机免费前进 4 格（吃跃迁/撞子规则，可能意外到家）
    const t = payload && payload.target;
    if (!t) return fail;
    // v33 P0 修复：accel 等价于「用点数 4 走一步」，必须先过 computeLegalMoves。
    // 精确到达模式（needExactFinish 默认 true）下 rp+4 > FINISH_RP 时 applyMove 会
    // throw MOVE_EXCEEDS_HOME，而本函数位于 WS 消息回调内，抛出即进程崩溃。
    const legal = computeLegalMoves(game, seat, 4);
    if (!legal.some((m) => m.planeId === t.planeId)) return fail;
    const res = applyMove(game, seat, t.planeId, 4, { rng });
    game.players = res.game.players;
    game.items = res.game.items;
    game.ranking = res.game.ranking;
    game.itemCells = res.game.itemCells;
    game.items[seat].accel -= 1; // 注意：上面已用 res.game.items 替换 game.items，必须用新对象
    events.push({ type: 'use_item', seat, item: 'accel', planeId: t.planeId });
    res.events.forEach((e) => events.push(e));
    // v33 P0 修复：与 select 同口径判胜——团队赛必须整队 8 机到家，
    // 不能拿 ranking[0]（座位号）当 winner，否则战报队伍名错显且提前终局。
    if (game.teamMode) {
      const doneTeam = [0, 1].find((tm) =>
        game.players.filter((p) => p.team === tm).every((p) => p.finishedCount >= 4));
      if (doneTeam !== undefined) {
        game.winner = doneTeam;
        game.winnerTeam = doneTeam;
        game.phase = 'ended';
        game.seq += 1;
        return { game, events, ok: true };
      }
    } else if (res.game.ranking[0] !== undefined) {
      game.winner = res.game.ranking[0];
      game.phase = 'ended';
      game.seq += 1;
      return { game, events, ok: true };
    }
  } else if (item === 'swap') {
    // 交换两架都在跑道上的飞机位置（不限敌我）
    const targets = (payload && payload.targets) || [];
    if (targets.length !== 2) return fail;
    const A = game.players[targets[0].seat]
      && game.players[targets[0].seat].planes.find((x) => x.id === targets[0].planeId);
    const B = game.players[targets[1].seat]
      && game.players[targets[1].seat].planes.find((x) => x.id === targets[1].planeId);
    if (!A || !B) return fail;
    if (A.state !== 'track' || B.state !== 'track') return fail;
    const tmp = A.rp; A.rp = B.rp; B.rp = tmp;
    inv.swap -= 1;
    events.push({ type: 'use_item', seat, item: 'swap', targets });
  } else {
    return fail;
  }

  game.seq += 1;
  return { game, events, ok: true };
}

/**
 * 选定飞机并结算。返回 { game, events, extraRoll, switched }。
 */
function select(game, seat, planeId, dice, opts = {}) {
  if (game.phase !== 'selecting' || seat !== game.currentSeat) {
    return { game, events: [], extraRoll: false, switched: false };
  }
  const res = applyMove(game, seat, planeId, dice, {
    rng: opts.rng || Math.random,
    noDiceExtra: false,
  });
  game.players = res.game.players;
  game.items = res.game.items;
  game.ranking = res.game.ranking;
  game.movablePlanes = [];
  game.seq += 1;

  // 胜负判定：单人对局（第一个 4 机到齐）/ 团队赛（整队 8 机到齐）
  let ended = false;
  if (game.teamMode) {
    const doneTeam = [0, 1].find((t) =>
      game.players.filter((p) => p.team === t).every((p) => p.finishedCount >= 4));
    if (doneTeam !== undefined) {
      game.winner = doneTeam; // 团队赛 winner 存队伍号（0 红 / 1 蓝）
      game.winnerTeam = doneTeam;
      game.phase = 'ended';
      ended = true;
    }
  } else {
    const winnerSeat = res.game.ranking[0];
    if (winnerSeat !== undefined) {
      game.winner = winnerSeat;
      game.phase = 'ended';
      ended = true;
    }
  }
  if (ended) {
    return { game, events: res.events, extraRoll: false, switched: false };
  }

  // v10 额外投掷资格：多骰模式只认「击落敌机」，单骰沿用 v1（6 / 起飞 / 击落）
  const multi = diceCountOf(game) > 1;
  const gained = multi
    ? res.events.some((e) => e.type === 'kill')
    : !!res.extraRoll;
  if (gained) game.turnExtraRoll = true;

  // 消费掉当前这颗骰子，再推进到下一颗（用光则结算回合）
  game.diceIndex = (Number(game.diceIndex) || 0) + 1;
  const next = advanceDice(game, seat);

  return {
    game,
    events: res.events,
    extraRoll: !!next.extraRoll,
    switched: !!(next.turnEnd && !next.extraRoll),
    pending: next.pending || 0,
  };
}

/**
 * 全自动推进当前座位的一整个回合（含连掷、重掷、AI 自动选飞机）。
 * 用于自动对战压测，以及真人掉线后的 AI 托管。
 */
function playTurnAuto(game, seat, rng) {
  let guard = 0;
  while (game.phase !== 'ended' && guard < 200) {
    guard += 1;
    if (game.currentSeat !== seat) break;

    // v3 AI 主动用道具（炸弹/护盾）放在掷骰前，用完再走常规流程
    if (game.phase === 'rolling') {
      if (aiUseItems(game, seat, rng)) {
        if (game.phase === 'ended') break;
        continue;
      }
    }

    if (game.phase === 'selecting') {
      let planeId = choosePlane(game, seat, game.dice, game.players[seat].aiLevel);
      if (planeId == null && Array.isArray(game.movablePlanes) && game.movablePlanes.length) {
        planeId = game.movablePlanes[0];
      }
      if (planeId == null) { switchPlayer(game); break; }
      const sel = select(game, seat, planeId, game.dice, { rng });
      if (sel.switched || game.phase === 'ended') break;
      continue;
    }

    const rolled = roll(game, seat, rng);
    if (rolled.legal.length === 0) {
      if (game.phase === 'ended') break;
      if (game.currentSeat !== seat) break; // 已换人（跳过/连六作废）
      continue;
    }
  }
  return game;
}

module.exports = {
  createGame, roll, select, useItem, playTurnAuto, switchPlayer, isGameOver,
  diceCountOf, // v10 多骰模式：给前端/测试判断本局掷几颗
};
