/**
 * tournament.js — v21 全服锦标赛（8 人 · 两轮 · 单败）
 *
 * 赛制（4 人飞行棋的 8 人淘汰变体）：
 *   报名 → 8 位棋手（玩家 + 7 位虚拟棋手）分两个半区，每半区 4 人一桌。
 *   半区赛：玩家所在半区为真实对局（玩家 + 3 AI）；另一半区由引擎真实模拟。
 *   两半区各取前 2 名晋级决赛（4 人一桌，真实对局）。
 *   奖励（金币）：冠军 200 / 亚军 80 / 决赛 3-4 名 40 / 半区赛止步 10。
 *   服务器只落玩家真实对局与战报；模拟局纯内存（毫秒级）不计战绩。
 *
 * 状态存 meta.json（每人一条）。进度幂等：进行中重复 join 返回当前进度；
 * 半区赛房间被清理后可 join 重建（重打该轮）。
 */

const stats = require('./stats');
const meta = require('./meta');
const audit = require('./audit');
const { createGame, playTurnAuto, isGameOver } = require('./game-engine/game-controller');

const NAME_POOL = ['北风', '疾雷', '断云', '赤霄', '听雨', '苍岚', '破军', '凌霜', '惊鸿', '夜枭', '流火', '寒鸦'];
const REWARDS = { semiStop: 10, fourth: 40, second: 80, champion: 200 };
const MAX_SIM_STEPS = 200000;

const norm = (n) => String(n || '').trim().slice(0, 16);
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function getState(nick) {
  return meta.getTournament(norm(nick));
}

/** 引擎真实模拟一局 AI 全内战（毫秒级，纯内存，不入战绩），返回 finish 顺序的座位数组 */
function simulateGroup(seatConfigs) {
  const g = createGame(seatConfigs, {});
  const rng = () => 1 + Math.floor(Math.random() * 6); // rng() 即骰子值，必须 1-6
  let steps = 0;
  while (!isGameOver(g) && steps < MAX_SIM_STEPS) {
    playTurnAuto(g, g.currentSeat, rng);
    steps += 1;
  }
  if (!isGameOver(g)) return null; // 保险丝：理论上 1000 局自对弈证明必然终止
  // 首家 4 机到齐即终局，g.ranking 可能只有胜者——与 gameoverData 同口径按进度排全序
  return g.players.slice()
    .sort((a, b) => {
      const ar = a.finishRank === null || a.finishRank === undefined ? 99 : a.finishRank;
      const br = b.finishRank === null || b.finishRank === undefined ? 99 : b.finishRank;
      if (ar !== br) return ar - br;
      return b.finishedCount - a.finishedCount;
    })
    .map((p) => p.seat);
}

/** 报名：进行中幂等续赛；否则生成新 bracket（新 bracket 由 routes 层建房） */
function join(nick) {
  const key = norm(nick);
  if (!key) return { ok: false, error: 'NICK_REQUIRED' };
  const existing = meta.getTournament(key);
  if (existing && existing.stage !== 'done') {
    return { ok: true, t: existing, resumed: true };
  }
  const pool = shuffle(NAME_POOL).slice(0, 7).map((name) => ({
    nick: name,
    aiLevel: 2 + (Math.random() < 0.4 ? 1 : 0), // 虚拟棋手强度 2-3
  }));
  const groupA = [key].concat(pool.slice(0, 3).map((p) => p.nick)); // 玩家所在半区
  const groupB = pool.slice(3).map((p) => p.nick);
  const levels = {};
  pool.forEach((p) => { levels[p.nick] = p.aiLevel; });
  const t = {
    nick: key,
    stage: 'semi', // semi → final → done
    champion: false,
    reward: 0,
    roomNo: '',
    players: levels,
    semi: { groupA, groupB, qualifiedA: [], qualifiedB: [] },
    final: { players: [], rank: null },
    updatedAt: Date.now(),
  };
  meta.setTournament(key, t);
  audit.log('tournament_join', key, {});
  return { ok: true, t, resumed: false };
}

/** 半区赛 B 桌模拟：产出晋级决赛的 2 位虚拟棋手（幂等：已算过不再重算） */
function runOtherSemi(t) {
  if (t.semi.qualifiedB.length) return t.semi.qualifiedB;
  const seats = t.semi.groupB.map((n) => ({ type: 'ai', aiLevel: t.players[n] || 2 }));
  const order = simulateGroup(seats);
  if (!order) return [];
  const qualified = order.slice(0, 2).map((s) => t.semi.groupB[s]);
  t.semi.qualifiedB = qualified;
  meta.setTournament(t.nick, t);
  return qualified;
}

/** 半区赛结束结算：前 2 晋级决赛，否则止步发奖。返回 game_over 附带信息。 */
function settleSemi(t, data, seatNicks) {
  // data.order: [{seat, nick, rank, ...}]（gameoverData 产物）。AI 座位昵称与虚拟棋手名
  // 无对应关系，必须经 seatNicks（建房时记录的 座位→虚拟棋手名）映射。
  const nameOf = (p) => (p.seat === 0 ? t.nick : (seatNicks && seatNicks[p.seat]) || p.nick || ('seat' + p.seat));
  const ranked = (data.order || []).slice().sort((a, b) => a.rank - b.rank).map((p) => ({ seat: p.seat, rank: p.rank, nick: nameOf(p) }));
  const qualified = ranked.slice(0, 2).map((p) => p.nick);
  t.semi.qualifiedA = qualified;
  t.stage = 'final';
  meta.setTournament(t.nick, t);
  const advanced = qualified.includes(t.nick);
  const rank = (ranked.find((p) => p.nick === t.nick) || {}).rank || null;
  stats.bumpDailyTournament(t.nick); // v28 锦标赛对局计入每日任务
  audit.log('tournament_semi', t.nick, { advanced, rank });
  if (advanced) {
    meta.pushMail(t.nick, { kind: 'tournament', stage: 'semi', advanced: true, rank, season: stats.currentSeason() });
    return { on: true, stage: 'semi', advanced: true, rank };
  }
  // 止步：直接发安慰奖并结束
  finish(t, { rank, reward: REWARDS.semiStop, champion: false });
  return { on: true, stage: 'done', advanced: false, rank, reward: REWARDS.semiStop }; // 止步即赛程结束
}

/** 决赛结束结算：名次定奖励与冠军。 */
function settleFinal(t, data, seatNicks) {
  const nameOf = (p) => (p.seat === 0 ? t.nick : (seatNicks && seatNicks[p.seat]) || p.nick || ('seat' + p.seat));
  const ranked = (data.order || []).slice().sort((a, b) => a.rank - b.rank).map((p) => ({ seat: p.seat, rank: p.rank, nick: nameOf(p) }));
  const mine = ranked.find((p) => p.nick === t.nick) || {};
  const rank = mine.rank || null;
  t.final.rank = rank;
  const reward = rank === 1 ? REWARDS.champion : rank === 2 ? REWARDS.second : REWARDS.fourth;
  finish(t, { rank, reward, champion: rank === 1 });
  return { on: true, stage: 'final', advanced: true, rank, reward, champion: rank === 1 };
}

function finish(t, { rank, reward, champion }) {
  t.stage = 'done';
  t.final.rank = rank;
  t.reward = reward;
  t.champion = !!champion;
  meta.setTournament(t.nick, t);
  stats.awardCoins(t.nick, reward);
  if (champion) stats.unlockAchievements(t.nick, ['tournament_champ']); // v22 锦标赛冠军
  if (champion) meta.addTournamentChampion(t.nick, reward); // v26 历届冠军榜
  meta.pushMail(t.nick, {
    kind: 'tournament', stage: t.stage, rank, reward, champion,
    season: stats.currentSeason(),
  });
  audit.log('tournament_finish', t.nick, { rank, reward, champion });
}

/** websocket.endGame 钩子：room.tournament = { nick, stage } */
function applyResult(room, data) {
  const tinfo = room.tournament;
  if (!tinfo) return null;
  const t = meta.getTournament(tinfo.nick);
  if (!t || t.stage === 'done') return null;
  try {
    if (tinfo.stage === 'semi') return settleSemi(t, data, tinfo.seatNicks);
    if (tinfo.stage === 'final') return settleFinal(t, data, tinfo.seatNicks);
  } catch (e) {
    console.error('[tournament] settle failed:', e.message);
  }
  return null;
}

module.exports = { getState, join, runOtherSemi, applyResult, REWARDS };
