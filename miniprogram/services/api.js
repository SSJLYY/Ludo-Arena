// 房间/对局 API 封装（全部走云函数，客户端不直写数据库）
const cloudFn = require('../utils/cloud.js');

// ---------- 房间 ----------
function createRoom(opts) {
  return cloudFn.call('roomCreate', {
    password: opts.password || '',
    settings: opts.settings || {},
    quick: !!opts.quick,
    profile: opts.profile || {}
  }, { loading: true, loadingText: '创建中…' });
}

function joinRoom(opts) {
  return cloudFn.call('roomJoin', {
    roomId: opts.roomId || '',
    roomNo: opts.roomNo || '',
    password: opts.password || '',
    profile: opts.profile || {}
  }, { loading: true, loadingText: '加入中…' });
}

function seatAction(roomId, seatIndex, action, extra) {
  const app = getApp();
  return cloudFn.call('roomSeat', Object.assign({
    roomId: roomId,
    seatIndex: seatIndex,
    action: action,
    profile: app ? app.globalData.profile : {}
  }, extra || {}));
}

function leaveRoom(roomId) {
  return cloudFn.call('roomLeave', { roomId: roomId });
}

function startGame(roomId) {
  return cloudFn.call('gameStart', { roomId: roomId }, { loading: true, loadingText: '开局…' });
}

// ---------- 对局 ----------
function sendAction(gameId, action, payload, clientSeq) {
  return cloudFn.call('gameAction', {
    gameId: gameId,
    action: action,
    payload: payload || {},
    seq: clientSeq || 0
  });
}

// 心跳：hosted 传 true/false 时为主动托管开关（v1.1）
function heartbeat(roomId, hosted) {
  const data = { roomId: roomId };
  if (hosted === true || hosted === false) data.hosted = hosted;
  return cloudFn.call('gameHeartbeat', data);
}

// v1.3 表情互动
function sendEmote(roomId, type) {
  return cloudFn.call('roomEmote', { roomId: roomId, type: type });
}

// v1.3 好友排行榜
function getLeaderboard() {
  return cloudFn.call('getLeaderboard', {});
}

// 回放：拉取对局全部操作流水（分页，每页 100）
async function fetchMoves(gameId) {
  const coll = db().collection('moves');
  const out = [];
  for (let page = 0; page < 40; page++) {
    const res = await coll.where({ gameId: gameId })
      .orderBy('seq', 'asc').skip(page * 100).limit(100).get();
    out.push.apply(out, res.data);
    if (res.data.length < 100) break;
  }
  return out;
}

// ---------- 直接读（只读集合，安全规则 read:true / write:false） ----------
const db = () => wx.cloud.database();

function fetchRoom(roomId) {
  return db().collection('rooms').doc(roomId).get().then((res) => res.data);
}

function fetchGame(gameId) {
  return db().collection('games').doc(gameId).get().then((res) => res.data);
}

function fetchUser(userId) {
  return db().collection('users').doc(userId).get().then((res) => res.data);
}

module.exports = {
  createRoom,
  joinRoom,
  seatAction,
  leaveRoom,
  startGame,
  sendAction,
  heartbeat,
  sendEmote,
  getLeaderboard,
  fetchMoves,
  fetchRoom,
  fetchGame,
  fetchUser
};
