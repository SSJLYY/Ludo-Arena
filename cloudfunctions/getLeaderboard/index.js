const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// v1.3 好友排行榜：服务端聚合 users（管理端可读，绕开「只能读本人」的安全规则），
// 只返回白名单字段，不暴露 openId
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { err: 'NO_AUTH' };

  const MEDALS = ['🥇', '🥈', '🥉'];
  try {
    const top = await db.collection('users')
      .where({ 'stats.games': _.gt(0) })
      .orderBy('stats.wins', 'desc')
      .limit(20)
      .get();
    const rows = top.data.map((u, i) => ({
      rank: i + 1,
      medal: MEDALS[i] || String(i + 1),
      nickName: u.nickName || '飞机师',
      avatarUrl: u.avatarUrl || '',
      games: (u.stats && u.stats.games) || 0,
      wins: (u.stats && u.stats.wins) || 0,
      kills: (u.stats && u.stats.kills) || 0
    }));

    // 我的排名：胜场多于我的用户数 + 1
    let me = null;
    let myRank = 0;
    try {
      me = (await db.collection('users').doc(OPENID).get()).data;
    } catch (e) { /* 未登录过 */ }
    if (me && me.stats && me.stats.games > 0) {
      const cnt = await db.collection('users')
        .where({ 'stats.wins': _.gt(me.stats.wins || 0) })
        .count();
      myRank = cnt.total + 1;
    }

    return {
      ok: true,
      rows: rows,
      myRank: myRank,
      me: me ? {
        nickName: me.nickName || '飞机师',
        games: (me.stats && me.stats.games) || 0,
        wins: (me.stats && me.stats.wins) || 0,
        kills: (me.stats && me.stats.kills) || 0
      } : null
    };
  } catch (e) {
    console.warn('[getLeaderboard] failed', e && e.errMsg);
    return { err: 'LEADERBOARD_FAIL', msg: '排行榜加载失败，稍后再试' };
  }
};
