const cloud = require('wx-server-sdk');
const sec = require('./sec.js');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 登录：返回 openId 并 upsert 用户资料（头像昵称填写能力，合规采集）
// v1.1：昵称接入 msgSecCheck（openapi 不可用时容错放行）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { err: 'NO_AUTH', msg: '无法获取用户身份' };

  const users = db.collection('users');
  let user = null;
  try {
    user = (await users.doc(OPENID).get()).data;
  } catch (e) { /* 新用户 */ }

  const patch = { updatedAt: Date.now() };
  if (event && event.nickName) {
    const nick = String(event.nickName).slice(0, 20);
    if (nick !== (user && user.nickName)) {
      const check = await sec.checkText(OPENID, nick);
      if (!check.ok) return { err: 'NICKNAME_INVALID', msg: '昵称包含违规内容，换一个吧' };
    }
    patch.nickName = nick;
  }
  if (event && event.avatarUrl) patch.avatarUrl = String(event.avatarUrl).slice(0, 500);

  const data = Object.assign({
    nickName: '',
    avatarUrl: '',
    stats: { games: 0, wins: 0, kills: 0 },
    recentGames: [],
    lastRoomId: ''
  }, user || {}, patch);

  // 文档 _id = openId，便于客户端按 doc 直读自己的资料
  await users.doc(OPENID).set({ data });
  return { ok: true, openId: OPENID, user: data };
};
