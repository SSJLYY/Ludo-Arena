const express = require('express');
const router = express.Router();
const {
  createRoom, getRoom, joinRoom, setSeat, startGame, resetRoom, publicRoom, notifyRoomUpdate,
  takeoverSeat, toggleHost, listRooms, updateSettings,
} = require('../room-manager');
const { maybeScheduleAi } = require('../websocket');
const stats = require('../stats');
const ratelimit = require('../ratelimit');
const audit = require('../audit');

/** v16 昵称占用校验 + 拦截审计：返回 true 表示已拒绝（res 已响应） */
function nickGuard(res, nickName, token, via) {
  if (!nickName) return false; // 默认昵称（房主/玩家/挑战者）不参与占用
  const own = stats.verifyNickOwnership(nickName, token);
  if (own.ok) {
    if (own.claimed) audit.log('secret_claim', nickName, { via });
    return false;
  }
  audit.log('blocked_nick', nickName, { via, error: own.error });
  res.status(400).json({ ok: false, error: own.error });
  return true;
}

/** v16 按客户端 IP 频率限制（防刷房刷满内存/大厅）：返回 true 表示已拦截 */
function ipGuard(res, name, req) {
  const g = ratelimit.guard(name, (req && req.ip) || 'unknown');
  if (g.ok) return false;
  audit.log('blocked_' + name, (req && req.ip) || 'unknown', { rule: name, error: g.error });
  res.status(429).json(g);
  return true;
}

// v7 在线房间大厅（必须放在 /:roomNo 之前，否则 "list" 会被当成房间号）
router.get('/list', (req, res) => {
  res.json({ ok: true, list: listRooms(30) });
});

// ================= v12 PVE 闯关 =================
// 一键开局：玩家坐 0 号位，其余 3 席按关卡难度配 AI，高关给 AI 让先。
// 🔴 必须放在 `/:roomNo/start` 之前，否则 "pve" 会被当成房间号。
// body: { nick, level }
router.post('/pve/start', (req, res) => {
  const nick = String((req.body && req.body.nick) || '').trim().slice(0, 16) || '挑战者';
  const level = Number((req.body && req.body.level) || 1);
  if (ipGuard(res, 'pveStart', req)) return;
  if (nickGuard(res, (req.body && req.body.nick) || '', (req.body && req.body.token) || '', 'pveStart')) return;
  try {
    const st = stats.pveState(nick);
    const L = stats.pveConfig(level);
    if (!L) throw new Error('LEVEL_NOT_FOUND');
    if (level > st.cleared + 1) throw new Error('LEVEL_LOCKED');

    const room = createRoom({
      settings: { aiLevel: L.aiLevel, diceMode: 1, allowItems: true, turnSeconds: 0 },
      nickName: nick,
    });
    stats.claimSecret(nick, (req.body && req.body.token) || '', true); // v15 凭证认领（仅首次，绝不阻断对局）
    room.pve = { level: L.lv, nick, name: L.name, coins: L.coins };
    // 🔴 动作名是 set_ai（不是 ai），否则 setSeat 落到 default 抛 ACTION_INVALID
    for (let i = 1; i <= 3; i++) setSeat(room.roomNo, i, 'set_ai', { aiLevel: L.aiLevel, requesterSeat: 0 });
    startGame(room.roomNo, 0);

    // 让先：把 AI 的前若干架飞机直接放到跑道上，制造初始劣势
    if (L.handicap && room.game) {
      for (let s = 1; s <= 3; s++) {
        const pl = room.game.players[s];
        if (!pl) continue;
        for (let k = 0; k < L.handicap.planes && k < pl.planes.length; k++) {
          pl.planes[k].state = 'track';
          pl.planes[k].rp = L.handicap.rp;
        }
      }
    }
    notifyRoomUpdate(room.roomNo);
    maybeScheduleAi(getRoom(room.roomNo));
    res.json({
      ok: true, roomNo: room.roomNo, hostClientId: room.seats[0].clientId,
      level: L.lv, name: L.name, room: publicRoom(room),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// 创建房间
router.post('/', (req, res) => {
  const { password, settings, nickName } = req.body || {};
  if (ipGuard(res, 'roomCreate', req)) return;
  if (nickGuard(res, nickName, (req.body && req.body.token) || '', 'roomCreate')) return;
  try {
    const room = createRoom({ password, settings, nickName });
    if (nickName) stats.claimSecret(nickName, (req.body && req.body.token) || '', true); // v15 凭证认领
    res.json({
      ok: true,
      roomNo: room.roomNo,
      hostClientId: room.seats[room.ownerSeat].clientId,
      room: publicRoom(room),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// 房间详情
router.get('/:roomNo', (req, res) => {
  const room = getRoom(req.params.roomNo);
  if (!room) return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND' });
  res.json({ ok: true, room: publicRoom(room) });
});

// 加入房间（可普通加入，也可 ?watch 观战）
router.post('/:roomNo/join', (req, res) => {
  const { password, clientId, nickName, watch } = req.body || {};
  if (ipGuard(res, 'roomJoin', req)) return;
  if (!watch && nickGuard(res, nickName, (req.body && req.body.token) || '', 'roomJoin')) return;
  try {
    const r = joinRoom(req.params.roomNo, { password, clientId, nickName, watch, ip: req.ip });
    if (!watch && nickName) stats.claimSecret(nickName, (req.body && req.body.token) || '', true); // v15 凭证认领
    res.json({ ok: true, seat: r.seat, spectator: r.spectator, room: publicRoom(getRoom(req.params.roomNo)) });
  } catch (e) {
    if (e.message === 'PWD_LOCKED') {
      audit.log('blocked_pwd', req.ip || 'unknown', { roomNo: req.params.roomNo });
      res.status(429).json({ ok: false, error: 'PWD_LOCKED', msg: '密码错误次数过多，请 10 分钟后再试' });
      return;
    }
    res.status(400).json({ ok: false, error: e.message });
  }
});

// 座位操作（房主）
router.post('/:roomNo/seat', (req, res) => {
  const { seat, action, aiLevel, requesterSeat, hostStyle } = req.body || {};
  try {
    const s = setSeat(req.params.roomNo, seat, action, { aiLevel, requesterSeat, hostStyle });
    notifyRoomUpdate(req.params.roomNo); // 推送房间更新，前端即时刷新
    res.json({ ok: true, seat: s });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// v13 房主修改自定义规则（仅等待态可改，开局后锁定）
router.post('/:roomNo/settings', (req, res) => {
  const { requesterSeat, settings } = req.body || {};
  try {
    const s = updateSettings(req.params.roomNo, Number(requesterSeat), settings || {});
    notifyRoomUpdate(req.params.roomNo); // 广播，让所有人看到新规则标签
    res.json({ ok: true, settings: s });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// 开局
router.post('/:roomNo/start', (req, res) => {
  const { requesterSeat } = req.body || {};
  try {
    startGame(req.params.roomNo, requesterSeat);
    // v12 携带道具：开局把每位真人的背包道具注入对局（每种最多带 2 张，自动扣背包）
    try {
      const rm = getRoom(req.params.roomNo);
      if (rm && rm.game) {
        rm.seats.forEach((s, i) => {
          if (s.type === 'human' && s.nickName) {
            const pl = stats.playerStats(s.nickName);
            if (pl && pl.props && pl.props.length) {
              const carry = pl.props.map((p) => ({ id: p.id, count: Math.min(p.count, 2) }));
              const used = stats.consumeProps(s.nickName, carry);
              if (used.length) {
                if (!rm.game.items[i]) rm.game.items[i] = {};
                used.forEach((id) => { rm.game.items[i][id] = (rm.game.items[i][id] || 0) + 1; });
              }
            }
          }
        });
      }
    } catch (e) { /* 携带失败不影响开局 */ }
    notifyRoomUpdate(req.params.roomNo); // 立即推送，让房主切到对局视图
    // 首回合若是 AI（例如房主把自己设成了电脑），立即驱动，否则纯 AI 局无法自启动
    maybeScheduleAi(getRoom(req.params.roomNo));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// v9 再来一局：房主把已结束的房间打回等待态（座位/昵称全保留）
// v9 再来一局：一局结束后把房间打回等待态并保留座位/昵称，
// 若 4 个座位都满则直接重开新一局（房主点一下即可，不用退出重配）。
router.post('/:roomNo/restart', (req, res) => {
  const { requesterSeat } = req.body || {};
  try {
    const room = resetRoom(req.params.roomNo, Number(requesterSeat));
    let started = false;
    const filled = room.seats.filter((s) => s.type !== 'empty');
    // v11 系列赛：若已是终局（current>=rounds），不再开新的一局，房间回到等待态
    const seriesDone = room.series && room.series.rounds > 1 && room.series.current >= room.series.rounds;
    if (filled.length === 4 && !seriesDone) {
      try { startGame(req.params.roomNo, Number(requesterSeat)); started = true; } catch (e) { /* 座位不齐则只回等待 */ }
    }
    if (started) maybeScheduleAi(getRoom(req.params.roomNo)); // 重开后首回合若是 AI 立即驱动
    notifyRoomUpdate(req.params.roomNo); // 所有人同步（重开则是新的 state 广播）
    res.json({ ok: true, room: publicRoom(room), started });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// 观战者接管 AI 座位（v2.0）
router.post('/:roomNo/takeover', (req, res) => {
  const { seat, clientId, nickName } = req.body || {};
  if (nickGuard(res, nickName, (req.body && req.body.token) || '', 'takeover')) return;
  try {
    const s = takeoverSeat(req.params.roomNo, Number(seat), clientId, nickName);
    if (nickName) stats.claimSecret(nickName, (req.body && req.body.token) || '', true); // v15 凭证认领
    notifyRoomUpdate(req.params.roomNo);
    res.json({ ok: true, seat: s });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// 手动托管开关（v2.0）：真人把座位交给 AI 代打 / 收回
// body: { seat, on, requesterSeat }  仅本人可托管自己座位
router.post('/:roomNo/host', (req, res) => {
  const { seat, on, requesterSeat } = req.body || {};
  try {
    if (Number(requesterSeat) !== Number(seat)) throw new Error('NOT_YOUR_SEAT');
    const s = toggleHost(req.params.roomNo, Number(seat), !!on);
    notifyRoomUpdate(req.params.roomNo);
    // 托管若正好轮到该座位，必须触发 AI 调度，否则回合无人行动卡死
    if (on) maybeScheduleAi(getRoom(req.params.roomNo));
    res.json({ ok: true, seat: s });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
