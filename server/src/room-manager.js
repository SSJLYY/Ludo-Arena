/**
 * room-manager.js — 房间内存管理与状态广播
 *
 * 房间活跃态全部在内存（Map），重启即丢，v1 可接受。
 * 战绩持久化（SQLite）留作 v1.1 增强。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { COLORS } = require('./game-engine/rules');
const { createGame } = require('./game-engine/game-controller');
const { tierOf, TIERS } = require('./tiers');
const stats = require('./stats');
const { sendToSpectators } = require('./spectate'); // v14 观战延迟防偷跑（与 websocket.js 共用）

const rooms = new Map(); // roomNo -> room

// v31 AI 名字池：让电脑对手有个性（按座位顺序取名，避免同房重名）
const AI_NAME_POOL = ['北风', '疾雷', '断云', '赤霄', '听雨', '苍岚', '夜枭', '惊鸿'];
const aiNameOf = (seed) => AI_NAME_POOL[seed % AI_NAME_POOL.length];

// v8 房间持久化：房间快照存 /app/data（挂载卷，容器重建不丢）
const DATA_DIR = process.env.STATS_DIR || path.join(__dirname, '..', 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
let _snapshotTimer = null;

const PASSWORD_SALT = 'flightchess-2026';

function hashPassword(pwd) {
  if (!pwd) return '';
  return crypto.createHash('sha256').update(pwd + PASSWORD_SALT).digest('hex');
}

function genRoomNo() {
  for (let i = 0; i < 100; i++) {
    const no = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
    if (!rooms.has(no)) return no;
  }
  throw new Error('ROOM_NO_EXHAUSTED');
}

/**
 * 创建房间。房主自动占位 seat 0（真人）。
 */
function createRoom({ password, settings, nickName } = {}) {
  const roomNo = genRoomNo();
    const seats = [0, 1, 2, 3].map((seat) => ({
    seat,
    color: COLORS[seat],
    type: 'empty', // empty | human | ai
    clientId: null,
    nickName: null,
    avatarUrl: null,
    everHuman: false, // 是否曾有真人坐过（掉线托管后仍算真人，战绩要入榜）
    hosted: false, // v2.0 托管标记（true=该真人座位当前由 AI 代打）
    autoHosted: false, // 掉线自动托管（true 时重连自动收回控制权）
    aiLevel: (settings && settings.aiLevel) || 2,
    online: false,
    lastSeen: 0,
  }));
    seats[0].type = 'human';
  seats[0].nickName = nickName || '房主';
  seats[0].everHuman = true;
  seats[0].clientId = 'host-' + crypto.randomBytes(4).toString('hex');
  seats[0].online = true;
  seats[0].lastSeat = 0;
  seats[0].hostStyle = 'balanced'; // 托管 AI 风格：aggressive/balanced/defensive

  // v10 对局模式兜底：只接受 1/2/3，非法值一律回落到经典单骰
  const dm = Number(settings && settings.diceMode);
  const diceMode = dm === 2 || dm === 3 ? dm : 1;

  const room = {
    roomNo,
    passwordHash: hashPassword(password),
    hasPassword: !!password,
    ownerSeat: 0,
    status: 'waiting', // waiting | playing | finished
    seats,
    settings: Object.assign(
      {
        needExactFinish: true, // 精确到达（false = 弹回模式）
        allowStack: true,
        allowJump: true,  // 同色格跳格
        allowFly: true,   // v2.0 飞行箭头（rp36 → +12）
        allowItems: true, // v2.0 道具卡（护盾/重掷）
        aiLevel: 2,
        diceMode,         // v10 对局模式：1 经典单骰 / 2 双骰狂野 / 3 三骰狂欢
        teamMode: false,  // v8 2v2 团队赛（默认关，单人对局零回归）
        turnSeconds: 30,  // v9 防挂机倒计时
        seriesRounds: 1,  // v11 系列赛总局数（1=单局；>1 开启多局积分赛）
        knockout: false,  // v12 淘汰赛：系列赛每局末名出局（需 seriesRounds>1 才生效）
        takeoffAny: false, // v13 任意点数起飞（false=仅掷6可起飞）
        crashBack: true,  // v13 撞子回基地（false=和平模式，落敌方头顶不撞）
        roundLimit: 0,    // v13 回合上限（0=不限；>0 超时按总进度判胜）
        turbo: false,     // v13 极速模式：AI 步频加快 + 动画加速
      },
      settings || {}
    ),
    game: null,
    // v11 系列赛积分累加器：每局结束按座位累计，N 局后出总榜
    series: (() => {
      const rounds = Number(settings && settings.seriesRounds) || 1;
      const scores = {};
      [0, 1, 2, 3].forEach((i) => {
        scores[i] = { points: 0, wins: 0, homes: 0, kills: 0, sixes: 0 };
      });
      return { rounds, current: 1, scores };
    })(),
    clients: new Map(), // clientId -> ws（座位玩家）
    spectators: new Map(), // clientId -> { nickName }（观战者，v2.0）
    emotes: [], // 表情互动队列（v2.0）
    replayFrames: [], // v2.0 对局回放逐帧快照（state.data 序列）
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  rooms.set(roomNo, room);
  snapshotRooms(); // v8 即时快照：刚建房就落盘，避免崩溃丢房
  return room;
}

function getRoom(roomNo) {
  return rooms.get(roomNo) || null;
}

function findEmptySeat(room) {
  const idx = room.seats.findIndex((s) => s.type === 'empty');
  return idx;
}

/**
 * 加入房间。
 * @param {object} opt { password, clientId, nickName, watch }
 *   - watch=true 或房间已满 → 作为观战者加入（返回 seat=-1, spectator=true）
 *   - 否则分配空座位（返回 seat>=0, spectator=false）
 * 成功返回 { seat, spectator }，失败抛错误码。
 */
// v27 房间密码防爆破：每 房间+IP 记录错误次数，5 次/10 分钟内锁 10 分钟
const PWD_FAIL_LIMIT = 5;
const PWD_LOCK_MS = 10 * 60 * 1000;
const pwdFails = new Map(); // key: roomNo|ip -> { count, lockUntil }
const normIp = (ip) => String(ip || 'unknown').slice(0, 40);
function pwdLocked(roomNo, ip) {
  const k = normIp(roomNo) + '|' + normIp(ip);
  const rec = pwdFails.get(k);
  if (!rec) return false;
  if (rec.lockUntil && Date.now() < rec.lockUntil) return true;
  if (rec.lockUntil && Date.now() >= rec.lockUntil) { pwdFails.delete(k); }
  return false;
}
function recordPwdFail(roomNo, ip) {
  const k = normIp(roomNo) + '|' + normIp(ip);
  const rec = pwdFails.get(k) || { count: 0, lockUntil: 0 };
  rec.count += 1;
  if (rec.count >= PWD_FAIL_LIMIT) rec.lockUntil = Date.now() + PWD_LOCK_MS;
  pwdFails.set(k, rec);
  return rec;
}
function clearPwdFails(roomNo, ip) { pwdFails.delete(normIp(roomNo) + '|' + normIp(ip)); }

function joinRoom(roomNo, opt = {}) {
  const { password, clientId, nickName, watch, ip } = opt;
  const room = rooms.get(roomNo);
  if (!room) throw new Error('ROOM_NOT_FOUND');
  if (room.passwordHash && room.passwordHash !== hashPassword(password)) {
    if (ip && pwdLocked(roomNo, ip)) throw new Error('PWD_LOCKED');
    const rec = recordPwdFail(roomNo, ip);
    if (rec.count >= PWD_FAIL_LIMIT) throw new Error('PWD_LOCKED');
    throw new Error('WRONG_PASSWORD');
  }
  if (ip) clearPwdFails(roomNo, ip); // 密码正确即清零
  if (room.status === 'playing') throw new Error('GAME_STARTED');
  const seatIdx = findEmptySeat(room);
  // 满员或主动观战 → 观战席
  if (watch || seatIdx < 0) {
    // v35 观战者默认昵称自动编号（观战者1/2/3…），用户自定昵称不覆盖
    const specNick = nickName || ('观战者' + ((room.specSeq = (room.specSeq || 0) + 1)));
    room.spectators.set(clientId, { nickName: specNick });
    room.updatedAt = Date.now();
    notifyRoomUpdate(roomNo); // 房主立刻看到观战者进出
    return { seat: -1, spectator: true };
  }
  const seat = room.seats[seatIdx];
  seat.type = 'human';
  seat.clientId = clientId;
  seat.nickName = nickName || `玩家${seatIdx + 1}`;
  seat.everHuman = true;
  seat.online = true;
  seat.lastSeat = seatIdx;
  seat.lastSeen = Date.now();
  room.updatedAt = Date.now();
  // 关键：HTTP 加入不走 WS，必须主动广播，否则房主界面仍是旧座位表
  notifyRoomUpdate(roomNo);
  return { seat: seatIdx, spectator: false };
}

/**
 * v2.0 观战者接管 AI 座位（对局进行中可随时接管）。
 * 接管后该座位变为真人，观战者离席（从 spectators 移除）。
 */
function takeoverSeat(roomNo, seatIdx, clientId, nickName) {
  const room = rooms.get(roomNo);
  if (!room) throw new Error('ROOM_NOT_FOUND');
  const seat = room.seats[seatIdx];
  if (!seat) throw new Error('SEAT_INVALID');
  if (seat.type !== 'ai') throw new Error('NOT_AI_SEAT');
  seat.type = 'human';
  seat.clientId = clientId;
  seat.nickName = nickName || '接管者';
  seat.everHuman = true;
  seat.online = true;
  seat.lastSeat = seatIdx;
  seat.lastSeen = Date.now();
  room.spectators.delete(clientId);
  room.updatedAt = Date.now();
  return seat;
}

/**
 * 观战者加入/离开（WS 连接时调用）。
 */
function addSpectator(room, clientId, nickName) {
  room.spectators.set(clientId, { nickName: nickName || '观战者' });
}
function removeSpectator(room, clientId) {
  room.spectators.delete(clientId);
}
function spectatorList(room) {
  return Array.from(room.spectators.entries()).map(([clientId, s]) => ({
    clientId, nickName: s.nickName,
  }));
}

/**
 * 房主操作座位：set_ai / set_empty / set_human / set_level
 * 仅房主可操作非自身座位（v1：房主可改任意座位配置）。
 */
function setSeat(roomNo, seatIdx, action, { aiLevel, requesterSeat, hostStyle } = {}) {
  const room = rooms.get(roomNo);
  if (!room) throw new Error('ROOM_NOT_FOUND');
  if (requesterSeat !== undefined && room.ownerSeat !== requesterSeat) {
    throw new Error('NOT_OWNER');
  }
  if (room.status === 'playing') throw new Error('GAME_STARTED');
  const seat = room.seats[seatIdx];
  if (!seat) throw new Error('SEAT_INVALID');
  switch (action) {
    case 'set_ai':
      seat.type = 'ai';
      seat.aiLevel = aiLevel || seat.aiLevel || 2;
      if (hostStyle && ['aggressive', 'balanced', 'defensive'].includes(hostStyle)) seat.hostStyle = hostStyle;
      seat.clientId = null;
      seat.nickName = aiNameOf(seatIdx + (room.aiNameSeq = (room.aiNameSeq || 0) + 1) + (room.createdAt || 0)); // v31 个性名字
      seat.everHuman = false; // 房主主动设电脑：从头到尾不是真人，不进战绩榜
      seat.online = true;
      break;
    case 'set_empty':
      seat.type = 'empty';
      seat.clientId = null;
      seat.nickName = null;
      seat.everHuman = false;
      seat.online = false;
      break;
    case 'set_human':
      if (seat.type === 'ai' || seat.type === 'empty') {
        seat.type = 'human';
        seat.clientId = null;
        seat.nickName = `玩家${seatIdx + 1}`;
        seat.everHuman = true;
        seat.online = true;
      }
      break;
    case 'set_level':
      if (seat.type === 'ai') seat.aiLevel = aiLevel || seat.aiLevel;
      break;
    case 'set_style':
      // v13 设定该座位（AI 或托管中）的玩法风格
      if (['aggressive', 'balanced', 'defensive'].includes(hostStyle)) seat.hostStyle = hostStyle;
      break;
    default:
      throw new Error('ACTION_INVALID');
  }
  room.updatedAt = Date.now();
  return seat;
}

/**
 * v2.0 手动托管 / 接管：真人把座位交给 AI 代打（或收回）。
 * on=true → 托管（type=ai, hosted=true, 保留 clientId 不丢连接）；
 * on=false → 接管（type=human, hosted=false）。
 */
function toggleHost(roomNo, seatIdx, on) {
  const room = rooms.get(roomNo);
  if (!room) throw new Error('ROOM_NOT_FOUND');
  const seat = room.seats[seatIdx];
  if (!seat) throw new Error('SEAT_INVALID');
  if (seat.type !== 'human' && !seat.hosted) throw new Error('NOT_HUMAN_SEAT');
  seat.hosted = !!on;
  seat.type = on ? 'ai' : 'human';
  seat.autoHosted = false; // 手动操作优先级最高，清掉掉线标记
  room.updatedAt = Date.now();
  return seat;
}

function leaveRoom(roomNo, seatIdx) {
  const room = rooms.get(roomNo);
  if (!room) return;
  // 座位玩家离开
  if (seatIdx >= 0) {
    const seat = room.seats[seatIdx];
    if (seat) {
      // v33 修复：原实现先把 clientId 置 null 再取它去删除，实际只删了空键，
      // 真实 WS 引用残留在 room.clients（离座玩家仍收广播）。必须先取值再清理。
      const sid = seat.clientId;
      // v33 修复：对局进行中离座不能置空，否则 switchPlayer 停在无人座位 → 整局卡死。
      // 与掉线同口径转 AI 托管，保留昵称与 clientId（重连可接管）。
      if (room.status === 'playing' && seat.type === 'human') {
        seat.type = 'ai';
        seat.hosted = true;
        seat.autoHosted = true;
        seat.nickName = (seat.nickName || '') + '(托管)';
        seat.online = false;
        room.updatedAt = Date.now();
        notifyRoomUpdate(roomNo);
        return;
      }
      if (sid) room.clients.delete(sid);
      seat.type = 'empty';
      seat.clientId = null;
      seat.nickName = null;
      seat.online = false;
    }
  }
  room.updatedAt = Date.now();
  notifyRoomUpdate(roomNo); // 房主立刻看到座位空出来
}

/**
 * v2.0 表情互动：将一条表情推入房间队列（保留最近 30 条，供新观战者对齐水位）。
 */
function pushEmote(room, emote) {
  room.emotes.push(emote);
  if (room.emotes.length > 30) room.emotes = room.emotes.slice(-30);
}

/**
 * v2.0 对局回放：记录一帧 state 快照（仅对局进行中、有 game 时）。
 */
function recordReplayFrame(room, data) {
  if (!room.game) return;
  room.replayFrames.push({ t: Date.now(), room: data.room, game: data.game });
  if (room.replayFrames.length > 2000) room.replayFrames.shift();
}

/**
 * 开局：校验 4 座已满（真人 + AI 凑齐 4），初始化 game。
 */
function startGame(roomNo, requesterSeat) {
  const room = rooms.get(roomNo);
  if (!room) throw new Error('ROOM_NOT_FOUND');
  if (room.ownerSeat !== requesterSeat) throw new Error('NOT_OWNER');
  if (room.status === 'playing') throw new Error('GAME_STARTED');
  const filled = room.seats.filter((s) => s.type !== 'empty');
  if (filled.length !== 4) throw new Error('NOT_ENOUGH_PLAYERS');
  const seatConfigs = room.seats.map((s) => ({
    type: s.type,
    aiLevel: s.aiLevel || 2,
    hostStyle: s.hostStyle || 'balanced',
  }));
  room.game = createGame(seatConfigs, room.settings);
  room.status = 'playing';
  room.statsRecorded = false; // 新一局重新允许落战绩
  room.updatedAt = Date.now();
  snapshotRooms(); // v8 开局即时快照
  return room.game;
}

/**
 * v13 房主修改房间自定义规则（仅等待态可改，对局开始后锁定）。
 * 白名单收参，避免前端塞脏字段污染 settings。
 * @param {object} patch { takeoffAny, crashBack, roundLimit, turbo, diceMode, teamMode,
 *                         seriesRounds, knockout, needExactFinish, allowItems, turnSeconds }
 */
function updateSettings(roomNo, requesterSeat, patch) {
  const room = rooms.get(roomNo);
  if (!room) throw new Error('ROOM_NOT_FOUND');
  if (room.ownerSeat !== requesterSeat) throw new Error('NOT_OWNER');
  if (room.status === 'playing') throw new Error('GAME_STARTED');
  const allow = {
    takeoffAny: 'bool', crashBack: 'bool', turbo: 'bool', knockout: 'bool',
    needExactFinish: 'bool', allowItems: 'bool', allowJump: 'bool', allowFly: 'bool',
    teamMode: 'bool',
    roundLimit: 'int', diceMode: 'int', seriesRounds: 'int', turnSeconds: 'int', aiLevel: 'int',
  };
  Object.keys(patch || {}).forEach((k) => {
    if (!allow[k]) return;
    const v = patch[k];
    if (allow[k] === 'bool') room.settings[k] = !!v;
    else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return;
      room.settings[k] = Math.floor(n);
    }
  });
  // 系列赛/淘汰赛依赖 series 累加器，改总局数要同步重建
  const rounds = Number(room.settings.seriesRounds) || 1;
  if (!room.series || room.series.rounds !== rounds) {
    const scores = {};
    [0, 1, 2, 3].forEach((i) => { scores[i] = { points: 0, wins: 0, homes: 0, kills: 0, sixes: 0 }; });
    room.series = { rounds, current: 1, scores };
  }
  room.updatedAt = Date.now();
  snapshotRooms();
  return room.settings;
}

/**
 * v9 再来一局：一局结束后把房间打回等待态，保留座位/昵称/clientId，
 * 所有人不用退房间重配座位，房主点一下就能重开。
 * 只有房主能调，且必须这局真的结束了（phase === 'ended'）。
 */
function resetRoom(roomNo, requesterSeat) {
  const room = rooms.get(roomNo);
  if (!room) throw new Error('ROOM_NOT_FOUND');
  if (room.ownerSeat !== requesterSeat) throw new Error('NOT_OWNER');
  if (!room.game || room.game.phase !== 'ended') throw new Error('GAME_NOT_ENDED');
  // 归还托管座位：上一局被托管/掉线的真人，重开时恢复真人身份
  room.seats.forEach((s) => {
    if (s.eliminated) {
      // v12 淘汰赛：出局座位下一局不再参战，清空为空位（本人仍可留在页面观战）
      s.type = 'empty';
      s.hosted = false;
      s.autoHosted = false;
      return;
    }
    if (s.everHuman) {
      s.hosted = false;
      s.autoHosted = false;
      s.type = 'human';
      s.nickName = String(s.nickName || '').replace(/\(托管\)$/, '').trim();
    }
  });
  room.game = null;
  room.status = 'waiting';
  room.replayFrames = [];
  room.emotes = [];
  room.statsRecorded = false;
  room.turnDeadline = 0;
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  // v11 系列赛：重开即进入下一局，current 自增（封顶 rounds，避免终局后越界）
  if (room.series && room.series.rounds > 1) {
    if (room.series.current < room.series.rounds) room.series.current += 1;
  }
  room.updatedAt = Date.now();
  snapshotRooms(); // v8 重开即时快照
  return room;
}

/**
 * v9 服务器概况：给大厅显示「当前 N 人在玩」。
 */
function serverStats() {
  let waiting = 0, playing = 0, finished = 0, players = 0, spectators = 0;
  for (const r of rooms.values()) {
    if (r.status === 'playing') playing += 1;
    else if (r.status === 'waiting') waiting += 1;
    else finished += 1;
    players += r.seats.filter((s) => s.online).length;
    spectators += r.spectators ? r.spectators.size : 0;
  }
  return {
    rooms: rooms.size, waiting, playing, finished, players, spectators,
    uptime: Math.round(process.uptime()),
  };
}

/**
 * v9 僵尸房清理：定时扫掉没人管的房间，防止 /api/rooms/list 越堆越脏。
 *  - waiting 且 30 分钟没动静 且 没有任何在线连接 → 删
 *  - 已结束（finished）且 60 分钟没动静 → 删
 *  - playing 的房间永不清理（误杀代价太大）
 */
function startJanitor(intervalMs = 5 * 60 * 1000) {
  const timer = setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (const [no, r] of rooms) {
      if (r.status === 'playing') continue;
      const idle = now - (r.updatedAt || r.createdAt || now);
      const conns = (r.clients ? r.clients.size : 0) + (r.spectators ? r.spectators.size : 0);
      if (r.status === 'waiting' && idle > 30 * 60 * 1000 && conns === 0) { rooms.delete(no); removed += 1; }
      else if (r.status === 'finished' && idle > 60 * 60 * 1000) { rooms.delete(no); removed += 1; }
    }
    if (removed) console.log(`[janitor] cleaned ${removed} idle room(s)`);
  }, intervalMs);
  if (timer.unref) timer.unref(); // 别拖住进程退出
  return timer;
}

/**
 * 公开房间状态（脱敏，不含内部细节）。
 */
function publicRoom(room) {
  return {
    roomNo: room.roomNo,
    hasPassword: room.hasPassword,
    ownerSeat: room.ownerSeat,
    status: room.status,
    ranked: !!room.ranked,
    settings: room.settings,
    // v11 系列赛状态（单局房 series=null，前端据此判断不显示系列赛 UI）
    series: room.series || null,
    spectators: spectatorList(room), // v2.0 观战者列表
    seats: room.seats.map((s) => ({
      seat: s.seat,
      color: s.color,
      type: s.type,
      nickName: s.nickName,
      badges: s.type === 'human' && s.nickName ? stats.seatBadges(s.nickName) : null, // v24 荣誉徽标
      avatarUrl: s.avatarUrl,
      aiLevel: s.aiLevel,
      online: s.online,
      hosted: s.hosted, // v2.0 手动托管标记（前端显示"托管中"）
      eliminated: !!s.eliminated, // v12 淘汰赛：已出局座位（前端打叉显示）
      hostStyle: s.hostStyle || 'balanced', // v13 AI/托管风格（aggressive/balanced/defensive）
    })),
  };
}

function publicGame(room) {
  if (!room.game) return null;
  const g = room.game;
  return {
    seq: g.seq,
    currentSeat: g.currentSeat,
    phase: g.phase,
    // v9 防挂机：本回合剩余毫秒（0 = 无倒计时，例如轮到 AI 或房间里关掉了）
    turnLeft: room.turnDeadline ? Math.max(0, room.turnDeadline - Date.now()) : 0,
    // 绝对截止时间戳，前端据此本地平滑倒数（每帧重算 server 下发会跳变）
    turnDeadline: room.turnDeadline || 0,
    dice: g.dice,
    // v10 多骰模式：整组点数、当前用到第几颗、本局模式
    diceList: (g.diceList || []).slice(),
    diceIndex: Number(g.diceIndex) || 0,
    diceCount: g.diceCount || 1,
    diceHistory: (g.diceHistory || []).slice(-8),
    consecutiveSix: g.consecutiveSix,
    movablePlanes: g.movablePlanes,
    // v3：道具库存与道具格冷却
    items: g.items || [0, 1, 2, 3].map(() => ({ bomb: 0, shield: 0, accel: 0, swap: 0 })),
    itemCells: g.itemCells || {},
    allowItems: g.allowItems !== false,
    allowFly: g.allowFly !== false,
    players: g.players.map((p) => ({
      seat: p.seat,
      color: p.color,
      type: p.type,
      team: p.team, // v8 团队赛：座位所属队伍（null=单人对局，0 红 / 1 蓝）
      planes: p.planes,
      finishedCount: p.finishedCount,
      finishRank: p.finishRank,
      stats: p.stats,
    })),
    winner: g.winner,
    ranking: g.ranking,
  };
}

/**
 * v7 在线房间大厅：列出可加入的房间（等待中 + 无密码 + 还有空位或可观战）。
 * 只暴露必要信息，不泄露密码 / clientId。最近创建的排前面。
 * @param {number} limit 最多返回条数
 */
function listRooms(limit = 20) {
  const out = [];
  for (const room of rooms.values()) {
    if (room.status !== 'waiting') continue;
    if (room.hasPassword) continue;
    const humans = room.seats.filter((s) => s.type === 'human').length;
    const ais = room.seats.filter((s) => s.type === 'ai').length;
    const empties = room.seats.filter((s) => s.type === 'empty').length;
    if (empties <= 0 && !(room.spectators && room.spectators.size)) continue;
    const host = room.seats[room.ownerSeat];
    out.push({
      roomNo: room.roomNo,
      hostNick: (host && host.nickName) || '房主',
      humans, ais, empties,
      taken: humans + ais,
      spectators: room.spectators ? room.spectators.size : 0,
      aiLevel: room.settings ? room.settings.aiLevel : 2,
      diceMode: room.settings ? (room.settings.diceMode || 1) : 1, // v10 对局模式
      createdAt: room.createdAt,
    });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out.slice(0, Math.max(1, limit));
}

/**
 * 房间更新广播：座位变更/开局后主动推给房间内所有 WS 客户端。
 * 等待阶段的操作走 HTTP 接口、不经 WS，必须由这里主动广播，否则前端无感。
 */
function notifyRoomUpdate(roomNo) {
  const room = rooms.get(roomNo);
  if (!room) return;
  const payload = {
    type: 'state',
    data: { room: publicRoom(room), game: publicGame(room) },
  };
  for (const ws of room.clients.values()) {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  }
  // v3：观战者也同步房间状态（座位变化、观战人数等）；v14：同样走延迟防偷跑
  sendToSpectators(room, payload, 'state');
}

// ================= v7 增强 #17：段位天梯匹配 =================
// 匹配池：clientId -> { clientId, nick, ws, tierIndex, joinedAt }
const matchPool = new Map();
let _aiScheduler = null; // 由 websocket.js 注册 maybeScheduleAi，避免循环依赖

/** 按昵称查战绩算段位下标（0 青铜 ~ 4 王者）；查不到按青铜 */
function _tierIndexOf(nick) {
  let wins = 0;
  try { const p = stats.playerStats(nick); if (p && Number(p.wins)) wins = Number(p.wins); } catch (e) { /* ignore */ }
  const id = tierOf(wins).id;
  const idx = TIERS.findIndex((t) => t.id === id);
  return idx < 0 ? 0 : idx;
}

function joinMatchPool({ clientId, nick, ws }) {
  if (!clientId) return false;
  matchPool.set(clientId, {
    clientId,
    nick: String(nick || '玩家').slice(0, 16),
    ws,
    tierIndex: _tierIndexOf(nick),
    joinedAt: Date.now(),
  });
  return true;
}
function leaveMatchPool(clientId) { if (clientId) matchPool.delete(clientId); }
function matchPoolCount() { return matchPool.size; }
/** websocket.js 在加载时注册 AI 调度器（防止 room-manager ↔ websocket 循环 require） */
function setAiScheduler(fn) { _aiScheduler = typeof fn === 'function' ? fn : null; }
function _driveAi(room) { if (_aiScheduler) _aiScheduler(room); }

const MATCH_TICK_MS = 3000;
const MATCH_TIMEOUT_MS = 15000; // 等待超时才放宽段位 / 强制开局

function startMatchmaker(intervalMs = MATCH_TICK_MS) {
  const timer = setInterval(runMatchmaker, intervalMs);
  if (timer.unref) timer.unref(); // 别拖住进程退出
  return timer;
}

function runMatchmaker() {
  // 1) 清理掉线连接
  for (const [cid, e] of matchPool) {
    if (!e.ws || e.ws.readyState !== 1) matchPool.delete(cid);
  }
  const all = Array.from(matchPool.values()).sort((a, b) => a.joinedAt - b.joinedAt);
  if (!all.length) return;
  // 2) 广播当前匹配人数（前端显示「N 人匹配中」）
  const countMsg = JSON.stringify({ type: 'lobby', data: { count: all.length } });
  for (const e of all) { if (e.ws && e.ws.readyState === 1) e.ws.send(countMsg); }

  const now = Date.now();
  const matched = new Set();
  for (let i = 0; i < all.length; i++) {
    if (matched.has(all[i].clientId)) continue;
    const anchor = all[i];
    const overdue = now - anchor.joinedAt > MATCH_TIMEOUT_MS;
    const band = overdue ? 2 : 1; // 超时放宽到 ±2 段位
    let group = all
      .filter((p) => !matched.has(p.clientId) && Math.abs(p.tierIndex - anchor.tierIndex) <= band)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .slice(0, 4);
    const remaining = all.filter((p) => !matched.has(p.clientId));
    if (group.length < 2 && overdue && remaining.length >= 2) {
      // 超时兜底：忽略段位，取最早 2~4 人直接开，避免无限等待
      group = remaining.slice(0, remaining.length >= 4 ? 4 : 2);
    }
    if (group.length >= 2) {
      try { createRankedRoom(group); }
      catch (e) { console.error('[match] create ranked room failed:', e.message); continue; }
      group.forEach((p) => { matched.add(p.clientId); matchPool.delete(p.clientId); });
    }
  }
}

/**
 * 创建天梯房：把匹配到的真人塞进前 N 个座位，其余补 AI，立即开局。
 * players: [{ clientId, nick, ws }]（数组顺序即座位号 0..N-1）。
 */
function createRankedRoom(players) {
  const roomNo = genRoomNo();
  const seats = [0, 1, 2, 3].map((seat) => ({
    seat, color: COLORS[seat], type: 'empty', clientId: null, nickName: null,
    avatarUrl: null, everHuman: false, hosted: false, autoHosted: false,
    aiLevel: 2, online: false, lastSeen: 0,
  }));
  players.forEach((pl, idx) => {
    const s = seats[idx];
    s.type = 'human';
    s.clientId = pl.clientId;
    s.nickName = String(pl.nick || '玩家' + (idx + 1)).slice(0, 16);
    s.everHuman = true;
    s.online = false;
    s.lastSeat = idx;
  });
  for (let s = players.length; s < 4; s++) {
    seats[s].type = 'ai';
    seats[s].nickName = '电脑' + (s + 1);
    seats[s].online = true;
    seats[s].aiLevel = 2;
  }
  const room = {
    roomNo,
    passwordHash: '',
    hasPassword: false,
    ownerSeat: 0,
    status: 'playing',
    seats,
    settings: Object.assign(
      {
        needExactFinish: true, allowStack: true, allowJump: true, allowFly: true,
        allowItems: true, aiLevel: 2, diceMode: 1, turnSeconds: 30, ranked: true,
      }
    ),
    game: null,
    clients: new Map(),
    spectators: new Map(),
    emotes: [],
    replayFrames: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ranked: true,
  };
  rooms.set(roomNo, room);
  const seatConfigs = seats.map((s) => ({ type: s.type, aiLevel: s.aiLevel || 2 }));
  room.game = createGame(seatConfigs, room.settings);
  room.status = 'playing';
  room.statsRecorded = false;

  // 兜底：8 秒内仍未连入的真人座位（客户端崩溃等）→ 转 AI 托管，防止回合卡死
  const guardTimer = setTimeout(() => {
    const r = rooms.get(roomNo);
    if (!r) return;
    r.seats.forEach((s) => {
      if (s.type === 'human' && s.clientId && !r.clients.has(s.clientId)) {
        s.type = 'ai';
        s.hosted = true;
        s.autoHosted = true;
        s.nickName = String(s.nickName || '') + '(托管)';
      }
    });
    notifyRoomUpdate(roomNo);
    _driveAi(r);
  }, 8000);
  if (guardTimer.unref) guardTimer.unref();

  // 通知每位匹配者：通过 lobby ws 推送房间号 + 座位，前端据此自动跳房
  players.forEach((pl, idx) => {
    if (pl.ws && pl.ws.readyState === 1) {
      pl.ws.send(JSON.stringify({
        type: 'matched',
        data: { roomNo, seat: idx, clientId: pl.clientId, nick: pl.nick },
      }));
    }
  });
  return room;
}

// ================= v8 房间持久化（重启不丢房 / 不丢进行中对局） =================
function snapshotRooms() {
  const arr = [];
  for (const r of rooms.values()) {
    arr.push({
      roomNo: r.roomNo,
      passwordHash: r.passwordHash,
      hasPassword: r.hasPassword,
      ownerSeat: r.ownerSeat,
      status: r.status,
      seats: r.seats,
      settings: r.settings,
      game: r.game, // 纯数据对象，可序列化（无函数引用）
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ranked: !!r.ranked,
    });
  }
  const str = JSON.stringify({ ts: Date.now(), rooms: arr });
  const tmp = ROOMS_FILE + '.tmp';
  try { fs.writeFileSync(tmp, str); fs.renameSync(tmp, ROOMS_FILE); }
  catch (e) { console.error('[rooms] snapshot failed:', e.message); }
}

/** 进程启动时调用：从磁盘恢复房间（不驱动 AI，AI 由 recoverPlayingRooms 在 scheduler 就绪后驱动） */
function loadRooms() {
  let arr = [];
  try {
    const raw = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    arr = Array.isArray(raw && raw.rooms) ? raw.rooms : [];
  } catch (e) { return; }
  let n = 0;
  for (const r of arr) {
    if (!r || !r.roomNo || rooms.has(r.roomNo)) continue;
    const room = Object.assign({}, r);
    room.clients = new Map();
    room.spectators = new Map();
    room.emotes = [];
    room.replayFrames = [];
    room.turnDeadline = 0;
    room.turnTimer = null;
    room.aiToken = 0;
    room.statsRecorded = (r.status === 'finished');
    rooms.set(room.roomNo, room);
    n += 1;
  }
  if (n) console.log(`[rooms] recovered ${n} room(s) from disk`);
}

/** 重启后：playing 房间重新驱动 AI；真人座位给 10s 重连窗口，超时转托管防卡死 */
function recoverPlayingRooms() {
  for (const r of rooms.values()) {
    if (r.status !== 'playing' || !r.game) continue;
    const cur = r.game.currentSeat;
    if (r.seats[cur] && r.seats[cur].type === 'ai') _driveAi(r);
    setTimeout(() => {
      const rr = rooms.get(r.roomNo);
      if (!rr || rr.status !== 'playing') return;
      let changed = false;
      rr.seats.forEach((s) => {
        if (s.type === 'human' && !s.hosted && !rr.clients.has(s.clientId)) {
          s.type = 'ai'; s.hosted = true; s.autoHosted = true;
          s.nickName = String(s.nickName || '') + '(托管)';
          changed = true;
        }
      });
      if (changed) { notifyRoomUpdate(r.roomNo); _driveAi(rr); }
    }, 10000);
  }
}

function startSnapshotter(intervalMs = 10000) {
  if (_snapshotTimer) clearInterval(_snapshotTimer);
  _snapshotTimer = setInterval(() => { try { snapshotRooms(); } catch (e) { /* ignore */ } }, intervalMs);
  if (_snapshotTimer.unref) _snapshotTimer.unref();
  return _snapshotTimer;
}

/** v12 后台强制关房：踢出所有连接并从内存移除（P4 运维可控） */
function closeRoom(no) {
  const room = rooms.get(String(no || ''));
  if (!room) return false;
  try { if (room.turnTimer) clearTimeout(room.turnTimer); } catch (e) { /* noop */ }
  const sendClosed = (ws) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'room_closed' })); } catch (e) { /* noop */ } };
  if (room.clients) room.clients.forEach(sendClosed);
  // v14 修复：spectators 的值是 { nickName, ws }（v2.0 起不再是裸 ws），此前 room_closed 从未真正送达观战者
  if (room.spectators) room.spectators.forEach((sp) => sendClosed(sp && sp.ws));
  rooms.delete(room.roomNo);
  return true;
}

module.exports = {
  rooms,
  createRoom,
  getRoom,
  joinRoom,
  takeoverSeat,
  addSpectator,
  removeSpectator,
  spectatorList,
  pushEmote,
  recordReplayFrame,
  setSeat,
  toggleHost,
  leaveRoom,
  startGame,
  resetRoom,
  publicRoom,
  publicGame,
  listRooms,
  serverStats,
  startJanitor,
  notifyRoomUpdate,
  hashPassword,
  // v7 增强 #17 段位天梯匹配
  joinMatchPool,
  leaveMatchPool,
  matchPoolCount,
  startMatchmaker,
  setAiScheduler,
  // v8 房间持久化
  snapshotRooms,
  loadRooms,
  recoverPlayingRooms,
  startSnapshotter,
  // v12 后台强制关房
  closeRoom,
  // v13 自定义规则
  updateSettings,
};
