const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const AI_NAMES = { 1: '电脑·简单', 2: '电脑·普通', 3: '电脑·困难', 4: '电脑·大师' };

function emptySeat(i) {
  return {
    index: i,
    color: ['red', 'yellow', 'blue', 'green'][i],
    type: 'empty',
    openId: '',
    nickName: '',
    avatarUrl: '',
    aiLevel: 0,
    isOnline: false,
    lastSeen: 0,
    isHosted: false
  };
}

function aiSeat(i, level) {
  const lv = [1, 2, 3, 4].indexOf(level) >= 0 ? level : 2;
  return Object.assign(emptySeat(i), {
    type: 'ai',
    nickName: AI_NAMES[lv],
    aiLevel: lv
  });
}

function humanSeat(i, openId, profile) {
  return Object.assign(emptySeat(i), {
    type: 'human',
    openId: openId,
    nickName: (profile && profile.nickName) || '玩家' + (i + 1),
    avatarUrl: (profile && profile.avatarUrl) || '',
    isOnline: true,
    lastSeen: Date.now()
  });
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { err: 'NO_AUTH' };

  const settings = Object.assign({
    needExactFinish: true,  // 终点精确到达（可关：超出弹回）
    allowJump: true,        // 同色跳格
    allowFly: true,         // v1.1 飞行箭头（+12 飞跃）
    allowItems: true,       // v1.6 道具卡（护盾/重掷）
    allowStack: true,       // 叠子（v1 恒为展示用途）
    aiLevel: 2              // 默认 AI 难度：普通
  }, (event && event.settings) || {});
  const password = (event && event.password) || '';
  const quick = !!(event && event.quick);
  const profile = (event && event.profile) || {};

  // 生成不重复 6 位房号
  const rooms = db.collection('rooms');
  let roomNo = '';
  for (let i = 0; i < 12; i++) {
    const candidate = String(Math.floor(100000 + Math.random() * 900000));
    const dup = await rooms.where({ roomNo: candidate }).count();
    if (dup.total === 0) { roomNo = candidate; break; }
  }
  if (!roomNo) return { err: 'ROOM_NO_FAIL', msg: '房号生成失败，请重试' };

  const now = Date.now();
  const seats = [humanSeat(0, OPENID, profile), emptySeat(1), emptySeat(2), emptySeat(3)];
  if (quick) {
    const lv = settings.aiLevel || 2;
    seats[1] = aiSeat(1, lv);
    seats[2] = aiSeat(2, lv);
    seats[3] = aiSeat(3, lv);
  }

  const room = {
    roomNo: roomNo,
    hasPassword: !!password,   // v1.1：哈希与盐移入 room_auth 集合，客户端不可读
    ownerOpenId: OPENID,
    status: 'waiting',         // waiting | playing | finished | dissolved
    spectatorCount: 0,         // v1.14 观战人数（原子计数，硬上限）
    seats: seats,
    spectators: {},            // v1.14：观战席（按 openId 键控，配 spectatorCount 原子计数）
    emotes: [],                // v1.1：对局表情互动流水
    settings: settings,
    gameId: null,
    createdAt: now,
    updatedAt: now
  };
  const added = await rooms.add({ data: room });
  const roomId = added._id;

  // 密码凭证写入独立集合（安全规则 read:false，客户端完全不可读）
  // v1.3：错误计数改为按用户独立（failsByUser[openId] = {fails, lockUntil}）
  if (password) {
    const salt = crypto.randomBytes(8).toString('hex');
    await db.collection('room_auth').doc(roomId).set({
      data: {
        passwordHash: sha256(salt + password),
        salt: salt,
        failsByUser: {},
        updatedAt: now
      }
    });
  }

  // 记录 lastRoomId 供「继续上局」
  try {
    await db.collection('users').doc(OPENID).update({
      data: { lastRoomId: roomId, updatedAt: now }
    });
  } catch (e) { /* 未登录过用户，忽略 */ }

  return { ok: true, roomId: roomId, roomNo: roomNo, quick: quick };
};
