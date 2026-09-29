/**
 * websocket.js — WebSocket 连接管理 + 实时广播 + AI 自动推进
 *
 * 连接：/ws?roomNo=XXX&seat=N&clientId=YYY
 * 客户端消息：{ type: 'roll'|'select'|'reroll'|'host'|'emoji'|'chat'|'heartbeat'|'leave', payload }
 * 服务端消息：{ type: 'state'|'chat'|'emoji'|'error'|'pong'|'game_over', data }
 */

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const APP_VERSION = require('./version'); // v39 pong 携带版本，客户端检测新旧 JS 连新服务的漂移
const {
  getRoom, publicRoom, publicGame, leaveRoom, addSpectator, removeSpectator, pushEmote,
  recordReplayFrame, toggleHost,
  joinMatchPool, leaveMatchPool, matchPoolCount, setAiScheduler,
} = require('./room-manager');
const replays = require('./replays');
const { sendToSpectators, SPECTATE_DELAY_MS } = require('./spectate');
const {
  roll, select, useItem, isGameOver, switchPlayer,
} = require('./game-engine/game-controller');
const { choosePlane } = require('./game-engine/ai');
const { FINISH_RP } = require('./game-engine/rules');
const stats = require('./stats');

// v9 好友在线表：nick -> Set(ws)。用于好友邀战实时推送（大厅 WS 与对局 WS 都注册）。
const onlineUsers = new Map();
function regOnline(nick, ws) {
  nick = String(nick || '').trim();
  if (!nick) return;
  const wasOnline = onlineUsers.has(nick) && onlineUsers.get(nick).size > 0;
  if (!onlineUsers.has(nick)) onlineUsers.set(nick, new Set());
  onlineUsers.get(nick).add(ws);
  // v30 好友上线提醒：从离线变为在线时，通知所有把 TA 加为好友的在线玩家
  if (!wasOnline) {
    try {
      for (const friend of stats.friendsOf(nick)) pushNotify(friend, { nick });
    } catch (e) { /* ignore */ }
  }
}
function unregOnline(nick, ws) {
  nick = String(nick || '').trim();
  if (!nick) return;
  const set = onlineUsers.get(nick);
  if (set) { set.delete(ws); if (!set.size) onlineUsers.delete(nick); }
}
function pushInvite(toNick, data) {
  const set = onlineUsers.get(String(toNick || '').trim());
  if (!set) return false;
  let sent = false;
  for (const ws of set) {
    try { ws.send(JSON.stringify({ type: 'invite', data })); sent = true; } catch (e) { /* ignore */ }
  }
  return sent;
}

/** v30 通用好友通知推送（好友上线提醒） */
function pushNotify(toNick, data) {
  const set = onlineUsers.get(String(toNick || '').trim());
  if (!set) return false;
  let sent = false;
  for (const ws of set) {
    try { ws.send(JSON.stringify({ type: 'friend_online', data })); sent = true; } catch (e) { /* ignore */ }
  }
  return sent;
}

// 服务端权威随机源（防作弊）
const rng = () => crypto.randomInt(1, 7);

// AI 每步思考间隔（毫秒），让前端播动画；测试时可用 AI_STEP_DELAY 环境变量加速
const AI_STEP_DELAY = parseInt(process.env.AI_STEP_DELAY, 10) || 700;
const SPECTATOR_MAX = parseInt(process.env.SPECTATOR_MAX, 10) || 100; // v27 单房间观战上限
// v14 观战延迟防偷跑逻辑抽在 spectate.js（websocket / room-manager 两处下发共用）

/**
 * v33 统一安全发送：仅在 OPEN 状态发送并吞掉异常。
 * 历史上有多处直接 ws.send（心跳等）未做状态判断，极端时序下会抛
 * "WebSocket is not open"，而这里处于 WS 回调内 → 未捕获异常 → 进程退出。
 */
function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
  } catch (e) { /* ignore */ }
  return false;
}

function attachWebSocket(server) {
  // v37 maxPayload：游戏消息都是小 JSON，64KB 上限足够；超巨帧直接 1009 断连，防内存打爆
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  // v42 单 IP 并发连接上限（默认 50，WS_IP_MAX 可调）：防连接洪水耗尽句柄；NAT 多人同 IP 场景留足余量
  const WS_IP_MAX = Number(process.env.WS_IP_MAX) || 50;
  const ipConns = new Map();

  wss.on('connection', (ws, req) => {
    const _ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const _cur = (ipConns.get(_ip) || 0) + 1;
    // 先注册减量再判上限：被拒连接的 close 也要回收计数槽，否则洪水后该 IP 被永久锁死
    ws.on('close', () => {
      const n = (ipConns.get(_ip) || 1) - 1;
      if (n <= 0) ipConns.delete(_ip); else ipConns.set(_ip, n);
    });
    if (_cur > WS_IP_MAX) {
      try { ws.close(4008, 'too many connections'); } catch (e) { /* ignore */ }
      return;
    }
    ipConns.set(_ip, _cur);
    // v37：maxPayload 超限/帧解析错误时 ws 会 emit('error')，无监听会升级成 uncaughtException；
    // 传输层（receiverOnError）已自行按 1009 断连，这里静默吞掉即可
    ws.on('error', () => {});
    const url = new URL(req.url, 'http://localhost');
    const roomNo = url.searchParams.get('roomNo');
    const seatIdx = parseInt(url.searchParams.get('seat'), 10); // -1 = 观战者
    const clientId = url.searchParams.get('clientId');

    // 大厅 WS：天梯匹配队列（不入任何房间，单独管理 matchPool）
    if (roomNo === '__lobby__') { handleLobby(ws, url); return; }
    // 通知 WS：仅用于好友在线状态登记 + 实时邀请推送，不进匹配池（避免误匹配）
    if (roomNo === '__notify__') { handleNotify(ws, url); return; }

    const room = getRoom(roomNo);
    // 座位玩家：校验 clientId；观战者：房间必须存在
    const isSpectator = seatIdx === -1;
    if (!room) { ws.close(4001, 'room not found'); return; }
    if (!isSpectator) {
      if (!room.seats[seatIdx] || room.seats[seatIdx].clientId !== clientId) {
        ws.close(4001, 'auth failed'); return;
      }
      const s = room.seats[seatIdx];
      // 掉线自动托管后重连 → 自动收回控制权。
      // 手动托管不设 autoHosted，需本人点「取消托管」，不会被重连误清掉。
      if (s.autoHosted) {
        s.autoHosted = false;
        s.hosted = false;
        s.type = 'human';
        s.nickName = String(s.nickName || '').replace(/\(托管\)$/, '').trim();
        broadcastState(room);
      }
      room.clients.set(clientId, ws);
      s.online = true;
      s.lastSeen = Date.now();
      regOnline(String(s.nickName || '').replace(/\(托管\)$/, '').trim(), ws);
    } else {
      if (room.spectators.size >= SPECTATOR_MAX) { // v27 观战上限（防单房间内存滥用）
        ws.close(4029, 'spectator limit');
        return;
      }
      room.spectators.set(clientId, { nickName: '观战者' + ((room.specSeq = (room.specSeq || 0) + 1)), ws }); // v35 自动编号
      broadcastState(room); // v16：观战人数实时同步给房间内所有人（此前要等下一条 state 才可见）
    }

    // 接入快照：座位玩家实时；观战者延迟（v14 防偷跑——否则首帧直接看到当前盘面）
    // 此时观战者已注册进 room.spectators，直接走统一延迟下发
    const snapshot = { type: 'state', data: { room: publicRoom(room), game: publicGame(room) } };
    if (isSpectator) sendToSpectators(room, snapshot, 'state');
    else ws.send(JSON.stringify(snapshot));

    ws.on('message', (raw) => {
      // v12 防作弊/防洪：单连接 30 条/秒 上限（正常人手速远低于此），超限直接丢包
      if (!floodOk(ws)) return;
      if (raw && raw.length > 4096) return; // 超大包直接丢，正常消息不到 200 字节
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      handleMessage(room, seatIdx, msg, ws);
    });

    ws.on('close', () => {
      if (isSpectator) {
        removeSpectator(room, clientId);
        broadcastState(room);
        return;
      }
      room.clients.delete(clientId);
      // 房主掉线：托管 AI；普通玩家掉线：标记离线，超时由前端重连或房主托管
      const seat = room.seats[seatIdx];
      if (seat) {
        seat.online = false;
        seat.lastSeen = Date.now();
        unregOnline(String(seat.nickName || '').replace(/\(托管\)$/, '').trim(), ws);
        if (room.status === 'playing' && seat.type === 'human') {
          // 自动托管为 AI，避免整局卡死
          seat.type = 'ai';
          seat.hosted = true;
          seat.autoHosted = true; // 掉线标记：重连时自动收回控制权
          seat.nickName = seat.nickName + '(托管)';
          broadcastState(room);
          maybeScheduleAi(room);
        }
      }
    });
  });

  return wss;
}

/**
 * 大厅 WS（roomNo=__lobby__）：仅用于天梯匹配排队。
 * 客户端发送 match 入池、cancelMatch/leave 退池、heartbeat 保活；
 * 服务端定时把匹配成功者通过本连接推送 { type:'matched' }。
 */
function handleLobby(ws, url) {
  const clientId = url.searchParams.get('clientId');
  const nick = (url.searchParams.get('nick') || '').slice(0, 16);
  if (!clientId) { try { ws.close(4001, 'no clientId'); } catch (e) { /* ignore */ } return; }
  joinMatchPool({ clientId, nick, ws });
  regOnline(nick, ws);
  try { ws.send(JSON.stringify({ type: 'lobby', data: { joined: true, count: matchPoolCount() } })); } catch (e) { /* ignore */ }
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'cancelMatch' || msg.type === 'leave') {
      leaveMatchPool(clientId);
      try { ws.send(JSON.stringify({ type: 'lobby', data: { left: true } })); } catch (e) { /* ignore */ }
      if (msg.type === 'leave') { try { ws.close(); } catch (e) { /* ignore */ } }
    } else if (msg.type === 'heartbeat') {
      try { ws.send(JSON.stringify({ type: 'pong', data: { ts: Date.now(), v: APP_VERSION } })); } catch (e) { /* ignore */ }
    } else if (msg.type === 'invite') {
      const to = String((msg.payload && msg.payload.to) || '').trim();
      const from = String((msg.payload && msg.payload.from) || nick || '').trim();
      const roomNo = String((msg.payload && msg.payload.roomNo) || '').slice(0, 6);
      if (to && roomNo) pushInvite(to, { from, fromNick: from, roomNo });
    }
    // 'match' 无需处理（已在池中）
  });
  ws.on('close', () => { leaveMatchPool(clientId); unregOnline(nick, ws); });
  ws.on('error', () => { leaveMatchPool(clientId); unregOnline(nick, ws); });
}

/**
 * 通知 WS（roomNo=__notify__）：常驻连接，仅用于好友在线状态登记与实时邀请推送。
 * 与 __lobby__ 的区别：不进 matchPool，绝不会触发自动匹配。
 */
function handleNotify(ws, url) {
  const clientId = url.searchParams.get('clientId');
  const nick = (url.searchParams.get('nick') || '').slice(0, 16);
  if (!clientId || !nick) { try { ws.close(4001, 'no clientId/nick'); } catch (e) {} return; }
  regOnline(nick, ws);
  try { ws.send(JSON.stringify({ type: 'notify', data: { joined: true } })); } catch (e) {}
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'invite') {
      const to = String((msg.payload && msg.payload.to) || '').trim();
      const from = String((msg.payload && msg.payload.from) || nick || '').trim();
      const roomNo = String((msg.payload && msg.payload.roomNo) || '').slice(0, 6);
      if (to && roomNo) pushInvite(to, { from, fromNick: from, roomNo });
    } else if (msg.type === 'heartbeat') {
      try { ws.send(JSON.stringify({ type: 'pong', data: { ts: Date.now(), v: APP_VERSION } })); } catch (e) {}
    }
  });
  ws.on('close', () => unregOnline(nick, ws));
  ws.on('error', () => unregOnline(nick, ws));
}

/**
 * v12 连接级防洪：每个 ws 每秒最多 30 条消息。
 * 状态挂在 ws.__fl = { sec, n }，连接关闭自然回收。
 * 掉包而不断连：断连会触发掉线托管，反而伤到误触的正常玩家。
 */
function floodOk(ws) {
  const sec = Math.floor(Date.now() / 1000);
  if (!ws.__fl || ws.__fl.sec !== sec) { ws.__fl = { sec, n: 0 }; }
  ws.__fl.n += 1;
  return ws.__fl.n <= 30;
}

/**
 * v12 聊天防刷屏（服务端硬限流，前端限制形同虚设）。
 * 双闸门：① 相邻两条最少间隔 1200ms；② 滑动 10 秒窗口内最多 6 条。
 * 状态挂在 room._chatCd[seatIdx] = { last, hits: [ts...] }，房间销毁自然回收。
 */
const CHAT_MIN_GAP = 1200;
const CHAT_WINDOW = 10000;
const CHAT_WINDOW_MAX = 6;

function chatAllowed(room, seatIdx) {
  const now = Date.now();
  if (!room._chatCd) room._chatCd = {};
  const key = String(seatIdx);
  const rec = room._chatCd[key] || (room._chatCd[key] = { last: 0, hits: [] });
  if (now - rec.last < CHAT_MIN_GAP) return false;
  rec.hits = rec.hits.filter((t) => now - t < CHAT_WINDOW);
  if (rec.hits.length >= CHAT_WINDOW_MAX) return false;
  rec.last = now;
  rec.hits.push(now);
  return true;
}

function handleMessage(room, seatIdx, msg, ws) {
  const g = room.game;
  const isSpectator = seatIdx === -1;

  // —— 表情互动：所有连接（含观战者）都可发，服务端限频 3 秒 ——
  if (msg.type === 'emoji') {
    const now = Date.now();
    if (!room._emojiCd) room._emojiCd = {};
    if (room._emojiCd[seatIdx] && now - room._emojiCd[seatIdx] < 3000) return;
    room._emojiCd[seatIdx] = now;
    const emoji = String((msg.payload && msg.payload.emoji) || '').slice(0, 8) || '👍';
    const nick = isSpectator ? '观战者' : (room.seats[seatIdx] && room.seats[seatIdx].nickName) || '玩家';
    const emote = { ts: now, from: isSpectator ? '观战' : String(seatIdx), nick, type: emoji };
    pushEmote(room, emote);
    broadcast(room, { type: 'emoji', data: { seat: seatIdx, nick, emoji } });
    return;
  }

  // 观战者：只能发表情/聊天/离开/心跳，禁止任何对局操作
  if (isSpectator) {
    if (msg.type === 'chat') {
      const text = String(msg.payload && msg.payload.text || '').slice(0, 200);
      if (text.trim() && chatAllowed(room, -1)) broadcast(room, { type: 'chat', data: { seat: -1, nick: '观战者', text } });
    } else if (msg.type === 'leave') {
      removeSpectator(room, String(msg.clientId || ws.__cid || ''));
    } else if (msg.type === 'heartbeat') {
      safeSend(ws, { type: 'pong', data: { ts: Date.now(), v: APP_VERSION } });
    }
    return;
  }

  switch (msg.type) {
    case 'roll': {
      if (!g || g.phase !== 'rolling' || g.currentSeat !== seatIdx) return;
      if (room.seats[seatIdx].type !== 'human') return;
      roll(g, seatIdx, rng);
      broadcastState(room);
      maybeScheduleAi(room); // 结束时广播 game_over + 落战绩
      break;
    }
    case 'select': {
      if (!g || g.phase !== 'selecting' || g.currentSeat !== seatIdx) return;
      if (room.seats[seatIdx].type !== 'human') return;
      const planeId = msg.payload && msg.payload.planeId;
      if (planeId == null) return;
      select(g, seatIdx, planeId, g.dice, { rng });
      broadcastState(room);
      maybeScheduleAi(room); // 结束时广播 game_over + 落战绩
      break;
    }
    case 'useItem': {
      // v3 主动使用道具：自己回合（rolling/selecting）均可，不消耗骰子
      if (!g || g.phase === 'ended' || g.currentSeat !== seatIdx) return;
      if (room.seats[seatIdx].type !== 'human') return;
      const item = msg.payload && msg.payload.item;
      const payload = (msg.payload && msg.payload.payload) || {};
      // v33 P0 修复：引擎在非法参数下会 throw（如 PLANE_NOT_FOUND / MOVE_EXCEEDS_HOME），
      // 这里处于 WS 消息回调内，抛出即未捕获异常 → 进程退出。统一兜底成「非法使用」。
      let res;
      try {
        res = useItem(g, seatIdx, item, payload, rng);
      } catch (e) {
        console.error('[ws] useItem failed:', e && e.message);
        return;
      }
      if (!res.ok) return;
      broadcastState(room);
      maybeScheduleAi(room); // 道具可能直接结束对局（加速到家）→ 广播 game_over
      break;
    }
    case 'host': {
      // v2.0 手动托管：真人把座位交给 AI 代打（on=true）/ 收回（on=false）
      // 走 WS 而非 HTTP：托管若正好轮到该座位，必须就地触发 AI 调度，否则回合卡死。
      const seatInfo = room.seats[seatIdx];
      if (!seatInfo) return;
      const on = !!(msg.payload && msg.payload.on);
      if (on && (seatInfo.type !== 'human' || seatInfo.hosted)) return; // 非真人/已托管 → 忽略
      if (!on && !seatInfo.hosted) return; // 未托管 → 无需收回
      toggleHost(room.roomNo, seatIdx, on);
      broadcastState(room);
      if (on) maybeScheduleAi(room); // 立即驱动 AI，避免当前回合无人行动
      break;
    }
    case 'chat': {
      const text = String(msg.payload && msg.payload.text || '').slice(0, 200);
      if (!text.trim()) return;
      // v12 防刷屏：同座位 1.2 秒一条，且 10 秒内最多 6 条（超出静默丢弃，不报错免得被探测）
      if (!chatAllowed(room, seatIdx)) return;
      broadcast(room, { type: 'chat', data: { seat: seatIdx, nick: room.seats[seatIdx].nickName, text } });
      break;
    }
    case 'heartbeat': {
      room.seats[seatIdx].lastSeen = Date.now();
      safeSend(ws, { type: 'pong', data: { ts: Date.now(), v: APP_VERSION } });
      break;
    }
    case 'leave': {
      // v33 P0 修复：对局进行中把座位置空，switchPlayer 会停在空座上无人行动 → 整局永久卡死。
      // 与掉线处理（ws close）同口径：转 AI 托管，保留昵称与战绩，重连可接管；
      // 非对局态（等待中/已结束）才真正清空座位。
      const seat = room.seats[seatIdx];
      if (room.status === 'playing' && seat && seat.type === 'human') {
        seat.type = 'ai';
        seat.hosted = true;
        seat.autoHosted = true;
        seat.nickName = (seat.nickName || '') + '(托管)';
        seat.online = false;
        room.updatedAt = Date.now();
        broadcastState(room);
        maybeScheduleAi(room); // 正轮到该座时立即由 AI 接手
      } else {
        leaveRoom(room.roomNo, seatIdx);
        broadcastState(room);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * 若当前行动方是 AI 且游戏未结束，调度 AI 自动推进。
 */
/**
 * v13 回合上限超时判胜：roundLimit>0 且已打完这么多回合仍无自然胜者，
 * 按「总进度」选领先者强行结束（总进度 = 各机 rp 之和 + 已到家×57）。
 */
function forceEndByRound(room) {
  const g = room.game;
  if (!g || g.phase === 'ended') return;
  const progressOf = (seat) => g.players[seat].planes.reduce((s, pl) => s + (pl.rp < 0 ? 0 : pl.rp), 0)
    + g.players[seat].finishedCount * FINISH_RP;
  if (g.teamMode) {
    // v33 修复：团队赛 winner 必须是队伍号并同步 winnerTeam，
    // 否则 gameoverData 会把冠军队错显成固定的「红队」。
    const teamSum = [0, 1].map((t) =>
      g.players.reduce((s, p) => s + (p.team === t ? progressOf(p.seat) : 0), 0));
    const best = teamSum[1] > teamSum[0] ? 1 : 0;
    g.winner = best;
    g.winnerTeam = best;
    g.ranking = [best];
  } else {
    const prog = g.players.map((p, i) => progressOf(i));
    let best = 0;
    for (let i = 1; i < prog.length; i += 1) if (prog[i] > prog[best]) best = i;
    g.winner = best;
    g.winnerTeam = null;
    g.ranking = [best];
  }
  g.phase = 'ended';
  endGame(room);
}

function maybeScheduleAi(room) {
  const g = room.game;
  if (!g || g.phase === 'ended') {
    if (g && g.phase === 'ended') endGame(room);
    return;
  }
  // v33 兜底：当前座位若已被清空（异常路径/旧存档），直接跳过，避免整局卡死在无人座位
  let emptyGuard = 0;
  while (g.phase !== 'ended' && room.seats[g.currentSeat]
    && room.seats[g.currentSeat].type === 'empty' && emptyGuard < g.players.length) {
    switchPlayer(g);
    emptyGuard += 1;
  }
  if (g.phase === 'ended') { endGame(room); return; }
  // v13 回合上限：超时按进度判胜（一局唯一出口，保证只触发一次 game_over）
  if (room.settings && room.settings.roundLimit > 0 && g.roundNo >= room.settings.roundLimit) {
    forceEndByRound(room);
    return;
  }
  if (room.seats[g.currentSeat].type !== 'ai') return;
  scheduleAi(room);
}

/**
 * AI 调度（带令牌防重复链）：
 *   - room.aiToken 每次调度 +1，旧链醒来发现令牌不匹配则自杀，保证同一时刻只有一条链在跑。
 *   - select 兜底：choosePlane 为 null 时取 movablePlanes[0]；仍无则强制切人，绝不卡死。
 */
function scheduleAi(room) {
  const g = room.game;
  if (!g || g.phase === 'ended') {
    if (g) endGame(room);
    return;
  }
  if (room.seats[g.currentSeat].type !== 'ai') return;
  if (room.aiToken === undefined) room.aiToken = 0;
  const myToken = ++room.aiToken;

  const step = () => {
    const g2 = room.game;
    if (!g2 || g2.phase === 'ended' || room.aiToken !== myToken) {
      if (g2 && g2.phase === 'ended' && room.aiToken === myToken) endGame(room);
      return; // 令牌过期：有新链接管，本链退出
    }
    if (room.seats[g2.currentSeat].type !== 'ai') return; // 被人类接管
    const seat = g2.currentSeat;
    if (g2.phase === 'rolling') {
      roll(g2, seat, rng);
      broadcastState(room);
    } else if (g2.phase === 'selecting') {
      let pid = choosePlane(g2, seat, g2.dice, room.seats[seat].aiLevel);
      if (pid == null && Array.isArray(g2.movablePlanes) && g2.movablePlanes.length) {
        pid = g2.movablePlanes[0]; // 兜底 1：取第一个可走飞机
      }
      if (pid != null) {
        select(g2, seat, pid, g2.dice, { rng });
      } else {
        // 兜底 2：完全无解，强制切人（理论上不会到这，保险丝）
        switchPlayer(g2);
      }
      broadcastState(room);
    }
    maybeScheduleAi(room);
  };

  // v13 极速模式：缩短 AI 步频，让对局更紧凑（动画也由前端一并加速）
  const stepDelay = (room.settings && room.settings.turbo) ? Math.min(AI_STEP_DELAY, 220) : AI_STEP_DELAY;
  setTimeout(step, stepDelay);
}

/** game_over 完整数据：获胜者 + 按 4 机到家数排名 */
function gameoverData(room) {
  const g = room.game;
  const teamMode = !!g.teamMode;
  const winnerTeam = (g.winnerTeam !== undefined && g.winnerTeam !== null) ? g.winnerTeam : null;
  const order = g.players.slice().sort((a, b) => {
    if (a.finishRank !== null && b.finishRank !== null) return a.finishRank - b.finishRank;
    if (a.finishRank !== null) return -1;
    if (b.finishRank !== null) return 1;
    return b.finishedCount - a.finishedCount;
  });
  // v8 团队赛：winner 存队伍号，前端按队伍展示
  const winnerName = teamMode
    ? (winnerTeam === 0 ? '红队' : '蓝队')
    : (g.winner !== undefined && g.winner !== null ? room.seats[g.winner].nickName : '');
  return {
    winner: g.winner,
    winnerTeam,
    winnerName,
    teamMode,
    ranking: g.ranking,
    order: order.map((p, i) => ({
      seat: p.seat,
      team: p.team,
      nick: teamMode
        ? (p.team === winnerTeam ? (winnerTeam === 0 ? '红队' : '蓝队') : room.seats[p.seat].nickName)
        : room.seats[p.seat].nickName,
      color: p.color, finishedCount: p.finishedCount,
      rank: i + 1, isWinner: teamMode ? (p.team === winnerTeam) : (p.seat === g.winner),
      kills: p.stats.kills, beenKilled: p.stats.beenKilled,
      sixes: p.stats.sixes || 0,
    })),
  };
}

/**
 * v11 系列赛积分：一局结束时按座位累计，并返回系列赛汇总信息。
 * 计分：胜方 +3；每位玩家 + 到家飞机数（homes）；每位玩家 + 击落数（kills）。
 * 返回 { active, rounds, current, final, champion, scores[] }，final 时给出冠军。
 */
function applySeriesScore(room, d) {
  if (!room.series || room.series.rounds <= 1) {
    return { active: false, rounds: 1, current: 1, final: true, champion: null, scores: [] };
  }
  const s = room.series;
  // 累加本局积分
  (d.order || []).forEach((p) => {
    const acc = s.scores[p.seat];
    if (!acc) return;
    if (p.isWinner) acc.wins += 1;
    acc.homes += Number(p.finishedCount) || 0;
    acc.kills += Number(p.kills) || 0;
    acc.sixes += Number(p.sixes) || 0;
    acc.points += (p.isWinner ? 3 : 0) + (Number(p.finishedCount) || 0) + (Number(p.kills) || 0);
  });
  const final = s.current >= s.rounds;
  // 总榜：按积分降序，并列时比胜场、比到家数
  const scores = [0, 1, 2, 3].map((seat) => {
    const acc = s.scores[seat] || { points: 0, wins: 0, homes: 0, kills: 0, sixes: 0 };
    const seatInfo = room.seats[seat];
    return {
      seat,
      nick: seatInfo ? String(seatInfo.nickName || '').replace(/\(托管\)$/, '').trim() : '',
      color: seatInfo ? seatInfo.color : 'red',
      points: acc.points, wins: acc.wins, homes: acc.homes, kills: acc.kills, sixes: acc.sixes,
    };
  }).sort((a, b) => (b.points - a.points) || (b.wins - a.wins) || (b.homes - a.homes));
  const champion = final && scores.length ? scores[0].seat : null;
  return { active: true, rounds: s.rounds, current: s.current, final, champion, scores };
}

/**
 * 一局结束的统一出口：先落库（拿到新解锁成就）再广播 game_over。
 * 顺序很关键 —— 成就必须由 recordStats 算出来后塞进 game_over 推给前端。
 */
function endGame(room) {
  clearTurnTimer(room);
  const data = gameoverData(room);
  const extras = recordStats(room) || {};
  // v11 系列赛：累计积分并生成总榜（必须在 status 置 finished 前算，current 反映本局）
  const seriesInfo = applySeriesScore(room, data);
  // v12 淘汰赛：非终局时把本局末名（未出局者中最后一名）踢出下一局
  const knockoutInfo = applyKnockout(room, data, seriesInfo);
  // v12 PVE 闯关结算：0 号位真人赢了才算通关，服务端发币推进（跳关刷币由 stats.pvePass 拦）
  const pveInfo = applyPveResult(room, data);
  // v21 锦标赛结算：半区赛晋级/止步、决赛名次定奖励（一次性：结算后摘钩子防再来一局重复结算）
  let tournInfo = null;
  try {
    tournInfo = require('./tournament').applyResult(room, data);
    if (tournInfo) delete room.tournament;
  } catch (e) { console.error('[tournament] hook failed:', e.message); }
  // status 置 finished：房间进入「可再来一局」状态，也让僵尸房清理有了依据
  room.status = 'finished';
  room.updatedAt = Date.now();
  broadcast(room, {
    type: 'game_over',
    data: Object.assign({}, data, { achievements: extras.fresh || {} }, {
      series: seriesInfo,
      knockout: knockoutInfo,
      pve: pveInfo,
      tournament: tournInfo,
    }),
  });
}

/**
 * v12 淘汰赛：系列赛（rounds>1）且开了 knockout 时，每局结束淘汰本局末名。
 * 只淘汰仍在场的座位（type 非 empty 且未 eliminated），终局不再淘汰。
 * 实际清空座位发生在 resetRoom（下一局），这里只打标记 + 返回给前端播报。
 * @return {{on:boolean, out:number|null, nick:string, alive:number}}
 */
function applyKnockout(room, d, seriesInfo) {
  const on = !!(room.settings && room.settings.knockout) && !!(room.series && room.series.rounds > 1);
  if (!on) return { on: false, out: null, nick: '', alive: 0 };
  const alive = room.seats.filter((s) => !s.eliminated && s.type !== 'empty');
  if (seriesInfo.final || alive.length <= 2) {
    return { on: true, out: null, nick: '', alive: alive.length };
  }
  // order 已按名次升序 → 从后往前找第一个仍在场的座位
  const list = (d.order || []).slice().reverse();
  const loser = list.find((p) => {
    const s = room.seats[p.seat];
    return s && !s.eliminated && s.type !== 'empty' && p.seat !== d.winner;
  });
  if (!loser) return { on: true, out: null, nick: '', alive: alive.length };
  const seat = room.seats[loser.seat];
  seat.eliminated = true;
  return {
    on: true,
    out: loser.seat,
    nick: String(seat.nickName || '').replace(/\(托管\)$/, '').trim(),
    alive: alive.length - 1,
  };
}

/**
 * v12 PVE 闯关结算。房间由 /api/rooms/pve/start 创建，带 room.pve = { nick, level }。
 * 只有 0 号位（玩家本人）获胜才算通关；发币与进度推进都在 stats.pvePass 里做幂等。
 * @return {{on:boolean, cleared:boolean, level:number, coins:number, next:number}|null}
 */
function applyPveResult(room, d) {
  if (!room.pve) return null;
  const level = Number(room.pve.level) || 1;
  const win = d.winner === 0;
  if (!win) return { on: true, cleared: false, level, gained: 0, repeat: false, name: room.pve.name || '' };
  try {
    const r = stats.pvePass(room.pve.nick, level) || {};
    return {
      on: true,
      cleared: !!r.ok,
      repeat: !!r.repeat,
      level,
      gained: Number(r.gained) || 0,
      coins: Number(r.coins) || 0,
      name: r.name || room.pve.name || '',
    };
  } catch (e) {
    console.error('[pve] settle failed:', e.message);
    return { on: true, cleared: false, level, gained: 0, repeat: false, name: '' };
  }
}

/**
 * 一局结束 → 战绩持久化（含连胜/段位/成就评估）+ 回放存盘。
 * 只记真人（AI 不进榜）；中途掉线被托管的座位仍记本人（剥掉「(托管)」后缀）。
 * room.statsRecorded 保证一局只落一次库（多处 game_over 分支都会调到这里）。
 * @return {{fresh: Object<string,string[]>}} 每个真人新解锁的成就 id
 */
function recordStats(room) {
  if (room.statsRecorded) return { fresh: {} };
  room.statsRecorded = true;
  let fresh = {};
  try {
    const d = gameoverData(room);
    const seen = new Set();
    const rows = [];
    // 获胜者所面对的电脑难度（用于「大师克星」成就）
    const aiLevels = room.seats
      .filter((s) => s.type === 'ai' || s.hosted)
      .map((s) => Number(s.aiLevel) || 2);
    d.order.forEach((p) => {
      const seat = room.seats[p.seat];
      if (!seat || !seat.everHuman) return;
      const nick = String(p.nick || '').replace(/\(托管\)$/, '').trim().slice(0, 16);
      if (!nick || seen.has(nick)) return;
      seen.add(nick);
      const ps = (room.game && room.game.players[p.seat] && room.game.players[p.seat].stats) || {};
      rows.push({
        seat: p.seat, nick, color: p.color, rank: p.rank,
        finishedCount: p.finishedCount, kills: p.kills, beenKilled: p.beenKilled,
        sixes: ps.sixes || 0,
        isWinner: p.isWinner,
      });
    });
    // v19 战报推送下沉到 stats.recordGame（对局战报 + 成就解锁战报都在那里生成）
    if (rows.length) fresh = (stats.recordGame(rows, room.roomNo, { aiLevels, pveLevel: (room.pve && room.pve.level) || null }) || {}).fresh || {};
    // v12 公会战力：胜者 +3 / 参与者 +1，累到所属公会（没公会的自然跳过）
    try {
      const meta = require('./meta');
      rows.forEach((r) => {
        const g = meta.findGuildByMember(r.nick);
        if (g) meta.addGuildScore(g.gid, r.isWinner ? 3 : 1);
      });
    } catch (e) { /* 公会不可用不影响战绩 */ }
    // v2.0 回放：把逐帧快照落盘（提取真人昵称供列表展示）
    if (room.replayFrames && room.replayFrames.length) {
      const players = room.seats
        .filter((s) => s.everHuman)
        .map((s) => ({ seat: s.seat, nick: String(s.nickName || '').replace(/\(托管\)$/, '').trim(), color: s.color }));
      replays.saveReplay(room.roomNo, room.replayFrames, {
        winner: room.game ? room.game.winner : null,
        endedAt: Date.now(),
        players,
      });
    }
  } catch (e) {
    console.error('[stats] record failed:', e.message);
  }
  return { fresh };
}

/**
 * v9 防挂机倒计时：轮到真人时起一个定时器，超时自动替他行动。
 *  - rolling   → 自动掷骰
 *  - selecting → 自动走第一架可走飞机
 * 房间级开关 settings.turnSeconds（0 = 关闭），默认 30 秒。
 * 每次状态广播都会重设（换人/换阶段自然重置），所以只在这里挂一次调用即可。
 */
const DEFAULT_TURN_SECONDS = 30;

function clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  room.turnDeadline = 0;
}

function armTurnTimer(room) {
  clearTurnTimer(room);
  const g = room.game;
  if (!g || g.phase === 'ended') return;
  const seat = room.seats[g.currentSeat];
  if (!seat || seat.type !== 'human') return; // AI / 空座不计时

  const cfg = Number(room.settings && room.settings.turnSeconds);
  if (cfg === 0) return; // 房主关掉了倒计时
  const limit = (Number.isFinite(cfg) && cfg > 0 ? cfg : DEFAULT_TURN_SECONDS) * 1000;

  const mySeat = g.currentSeat;
  const myPhase = g.phase;
  room.turnDeadline = Date.now() + limit;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    room.turnDeadline = 0;
    const g2 = room.game;
    // 二次校验：期间可能已经被人操作过 / 换人 / 结束 / 被托管
    if (!g2 || g2.phase === 'ended' || g2.currentSeat !== mySeat || g2.phase !== myPhase) return;
    const s = room.seats[mySeat];
    if (!s || s.type !== 'human') return;

    if (g2.phase === 'rolling') {
      roll(g2, mySeat, rng);
    } else if (g2.phase === 'selecting') {
      const list = g2.movablePlanes || [];
      if (!list.length) return; // 无子可走：理论上不会发生，别乱动
      select(g2, mySeat, list[0], g2.dice, { rng });
    } else {
      return;
    }
    s.autoCount = (s.autoCount || 0) + 1;
    broadcast(room, { type: 'auto_play', data: { seat: mySeat, phase: myPhase, nick: s.nickName } });
    broadcastState(room);
    maybeScheduleAi(room);
  }, limit);
}

function broadcastState(room) {
  // 先排倒计时再序列化：publicGame 要把 turnLeft 一起带下去给前端画进度条
  armTurnTimer(room);
  const data = { room: publicRoom(room), game: publicGame(room) };
  broadcast(room, { type: 'state', data });
  recordReplayFrame(room, data); // v2.0 记录回放帧（仅对局进行中有效）
}

function broadcast(room, payload) {
  const str = JSON.stringify(payload);
  for (const ws of room.clients.values()) {
    if (ws.readyState === 1) ws.send(str);
  }
  // 观战者同样接收 state / game_over / emoji / chat（v14：state 延迟防偷跑，其余即时）
  sendToSpectators(room, str, payload.type);
}

// 把 AI 调度器注册给 room-manager（天梯房 8s 兜底转托管后需要驱动 AI，避免循环依赖）
setAiScheduler(maybeScheduleAi);

/** v13 好友在线状态：返回当前在线 nick 集合（供 /api/friend/list 标记绿点） */
function onlineNickSet() {
  return new Set(onlineUsers.keys());
}

module.exports = { attachWebSocket, maybeScheduleAi, onlineNickSet };
