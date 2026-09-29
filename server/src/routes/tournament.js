/**
 * routes/tournament.js — v21 锦标赛 HTTP 接口
 *
 * POST /api/tournament/join {nick, token}
 *   报名 / 续赛。生成 bracket；若当前轮房间已不存在（janitor 清理/中途退出）则重建。
 *   半区赛房 = 玩家(0 号位) + 同半区 3 位虚拟棋手(AI)。
 * GET /api/tournament?nick=
 *   当前进度（无则返回空态）。
 */

const express = require('express');
const router = express.Router();
const { createRoom, getRoom, setSeat, startGame, publicRoom, notifyRoomUpdate } = require('../room-manager');
const { maybeScheduleAi } = require('../websocket');
const tournament = require('../tournament');
const stats = require('../stats');
const ratelimit = require('../ratelimit');
const audit = require('../audit');

/** 给指定 nick 建一桌锦标赛对局：玩家 0 号位 + 对手昵称列表（AI 席） */
function buildRoom(t, opponents) {
  const room = createRoom({
    settings: { aiLevel: 2, diceMode: 1, allowItems: true, turnSeconds: 30 },
    nickName: t.nick,
  });
  stats.claimSecret(t.nick, '', true); // 建档（无 token 不认领，绝不阻断）
  opponents.forEach((opp, i) => {
    setSeat(room.roomNo, i + 1, 'set_ai', { aiLevel: t.players[opp] || 2, requesterSeat: 0 });
  });
  startGame(room.roomNo, 0);
  const seatNicks = opponents.reduce((m, n, i) => { m[i + 1] = n; return m; }, {});
  room.tournament = { nick: t.nick, stage: t.stage, seatNicks };
  t.roomNo = room.roomNo;
  metaSave(t);
  notifyRoomUpdate(room.roomNo);
  maybeScheduleAi(getRoom(room.roomNo)); // AI 先手时立即驱动
  return room;
}

// meta 直接经 tournament 模块的 meta 引用不可达，这里独立保存（读改写与 tournament.js 同一 meta 实例）
const meta = require('../meta');
function metaSave(t) { meta.setTournament(t.nick, t); }

router.post('/join', (req, res) => {
  const nick = String((req.body && req.body.nick) || '').trim().slice(0, 16);
  const token = String((req.body && req.body.token) || '').trim();
  if (!nick) return res.json({ ok: false, error: 'NICK_REQUIRED' });
  // 凭证校验（奖励发币的入口，须与 v15 身份体系一致）
  const v = stats.verifySecret(nick, token);
  if (!v.ok) {
    audit.log('auth_fail', nick, { rule: 'tournamentJoin', error: v.error });
    return res.json(v);
  }
  if (v.claimed) audit.log('secret_claim', nick, { via: 'tournamentJoin' });
  // 防刷：每 IP 每日 3 次报名 + 3 秒间隔
  const g = ratelimit.guard('tournamentJoin', (req && req.ip) || 'unknown');
  if (!g.ok) {
    audit.log('blocked_tournamentJoin', (req && req.ip) || 'unknown', { error: g.error });
    return res.status(429).json(g);
  }

  const j = tournament.join(nick);
  if (!j.ok) return res.json(j);
  const t = j.t;
  let room = null;
  try {
    if (t.stage === 'semi') {
      const live = t.roomNo && getRoom(t.roomNo) && getRoom(t.roomNo).status === 'playing';
      if (!live) room = buildRoom(t, t.semi.groupA.filter((n) => n !== t.nick));
    } else if (t.stage === 'final') {
      if (!t.semi.qualifiedB.length) tournament.runOtherSemi(t); // 另一半区模拟（幂等）
      const live = t.roomNo && getRoom(t.roomNo) && getRoom(t.roomNo).status === 'playing';
      if (!live) {
        // 决赛对手：同半区另一位晋级者 + 另一半区 2 位晋级者（都为 AI 席）
        const mates = t.semi.qualifiedA.filter((n) => n !== t.nick);
        const opponents = mates.concat(t.semi.qualifiedB).slice(0, 3);
        if (opponents.length < 3) return res.json({ ok: false, error: 'TOURNAMENT_BROKEN' });
        room = buildRoom(t, opponents);
      }
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  const liveRoom = room || (t.roomNo ? getRoom(t.roomNo) : null);
  res.json({
    ok: true,
    resumed: j.resumed,
    stage: t.stage,
    roomNo: liveRoom ? liveRoom.roomNo : t.roomNo,
    hostClientId: liveRoom ? liveRoom.seats[0].clientId : null,
    t,
  });
});

router.get('/', (req, res) => {
  const nick = String(req.query.nick || '').trim().slice(0, 16);
  if (!nick) return res.json({ ok: false, error: 'NICK_REQUIRED' });
  const t = tournament.getState(nick);
  res.json({ ok: true, t });
});

module.exports = router;
