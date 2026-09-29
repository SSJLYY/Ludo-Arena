'use strict';

// [共享模块] 对局结算与 CAS 写入：gameAction 与 aiTick（定时器）共用。
// 源文件 cloudfunctions/gameAction/shared.js —— 由 tools/sync-engine.js 同步到 aiTick。
// 请勿在副本里直接修改；改动请编辑源文件后运行 node tools/sync-engine.js

module.exports = function createShared(cloud, db, achievements) {

  // seq 乐观锁：条件更新，仅当版本号匹配时整快照替换
  async function casWrite(gameId, expectedSeq, state) {
    const data = Object.assign({}, state);
    delete data._id;
    data.seq = expectedSeq + 1;
    data.updatedAt = Date.now();
    const res = await db.collection('games').where({ _id: gameId, seq: expectedSeq })
      .update({ data: data });
    return !!(res.stats && res.stats.updated === 1);
  }

  // 分出胜负后：房间状态置 finished + 结算真人玩家战绩/连胜/成就（best-effort）
  async function onFinished(gameId, state, room) {
    if (!state || state.status !== 'finished') return;
    try {
      await db.collection('rooms').doc(state.roomId).update({
        data: { status: 'finished', updatedAt: Date.now() }
      });
    } catch (e) { /* 忽略 */ }

    const durationSec = Math.max(0, Math.round((Date.now() - state.createdAt) / 1000));
    // 对局中 AI 座位的难度（供「大师克星」成就判定）
    const aiLevels = [];
    for (const p of state.players) {
      if (p.type === 'ai') {
        const rs = room && room.seats ? room.seats[p.seat] : null;
        aiLevels.push((rs && rs.aiLevel) || (room && room.settings && room.settings.aiLevel) || 2);
      }
    }

    for (const p of state.players) {
      if (p.type !== 'human' || !p.openId) continue;
      try {
        const users = db.collection('users');
        let user = null;
        try { user = (await users.doc(p.openId).get()).data; } catch (e) { /* 新用户 */ }
        const stats = Object.assign({ games: 0, wins: 0, kills: 0 }, (user && user.stats) || {});
        stats.games += 1;
        const isWinner = state.winner === p.seat;
        if (isWinner) stats.wins += 1;
        stats.kills += p.stats.kills;
        // v1.8 生涯最高单局击落
        stats.bestKills = Math.max((user && user.stats && user.stats.bestKills) || 0, p.stats.kills);
        // 连胜：胜者 +1，败者归零
        const winStreakBefore = (user && user.winStreak) || 0;
        const winStreakAfter = isWinner ? winStreakBefore + 1 : 0;
        // 成就结算
        const ach = achievements.evaluateAchievements((user && user.achievements) || [], {
          isWinner: isWinner,
          totalWins: stats.wins,
          winStreakAfter: winStreakAfter,
          stats: { kills: p.stats.kills, sixes: p.stats.sixes, beenKilled: p.stats.beenKilled },
          beatenAiLevels: isWinner ? aiLevels : []
        });
        const recent = ((user && user.recentGames) || []).slice(0, 19);
        recent.unshift({
          gameId: gameId,
          roomId: state.roomId,
          rank: state.ranking.indexOf(p.seat) + 1,
          kills: p.stats.kills,
          winner: isWinner,
          durationSec: durationSec,
          newAchievements: ach.fresh,
          ts: Date.now()
        });
        await users.doc(p.openId).set({
          data: Object.assign({}, user || {}, {
            nickName: (user && user.nickName) || p.nickName || '',
            avatarUrl: (user && user.avatarUrl) || p.avatarUrl || '',
            stats: stats,
            winStreak: winStreakAfter,
            achievements: ach.all,
            recentGames: recent,
            updatedAt: Date.now()
          })
        });
      } catch (e) { /* 单个用户失败不影响对局 */ }
    }
  }

  return { casWrite: casWrite, onFinished: onFinished };
};
