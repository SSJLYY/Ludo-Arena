// [自动生成] 源文件 ../../miniprogram/engine/achievements.js —— 请勿直接修改；改动请编辑源文件后运行 node tools/sync-engine.js
'use strict';

// ============================================================
// 成就系统（v1.4）—— 纯函数，云函数结算与客户端成就墙共用
// 解锁判定只看「本局结算后的累计数据」，由云函数在对局结束时调用。
// ============================================================

// 成就定义（id 顺序即成就墙展示顺序）
var DEFINITIONS = [
  { id: 'first_win', icon: '🥇', name: '首胜', desc: '赢下第一场对局' },
  { id: 'streak_3', icon: '🔥', name: '三连胜', desc: '连续赢下 3 场对局' },
  { id: 'veteran', icon: '🏅', name: '常胜将军', desc: '累计赢下 10 场对局' },
  { id: 'ace', icon: '🎯', name: '王牌杀手', desc: '单局击落 5 架敌机' },
  { id: 'lucky', icon: '🍀', name: '天选之人', desc: '单局掷出 25 次六点' },
  { id: 'flawless', icon: '💎', name: '完美胜利', desc: '零被击落并获胜' },
  { id: 'comeback', icon: '💪', name: '绝地反击', desc: '被击落 3 架仍逆转获胜' },
  { id: 'master_slayer', icon: '⚔️', name: '大师克星', desc: '战胜 AI 大师' }
];

function find(id) {
  for (var i = 0; i < DEFINITIONS.length; i++) {
    if (DEFINITIONS[i].id === id) return DEFINITIONS[i];
  }
  return null;
}

/**
 * 结算一次对局后评估解锁。
 * @param existing 已解锁 id 列表（如 users.achievements）
 * @param ctx {
 *   isWinner        是否获胜
 *   totalWins       结算后的累计胜场
 *   winStreakAfter  结算后的连胜数
 *   stats           本局该玩家结算数据 {kills, sixes, beenKilled}
 *   beatenAiLevels  获胜时对局中 AI 座位的难度列表（非获胜或无房间数据传 []）
 * }
 * @return { fresh: [新解锁 id], all: [全部已解锁 id] }
 */
function evaluateAchievements(existing, ctx) {
  var have = {};
  var list = [];
  for (var e = 0; e < (existing || []).length; e++) {
    if (!have[existing[e]]) {
      have[existing[e]] = true;
      list.push(existing[e]);
    }
  }
  var fresh = [];
  function grant(id) {
    if (!have[id]) {
      have[id] = true;
      fresh.push(id);
      list.push(id);
    }
  }
  if (ctx && ctx.isWinner) {
    if (ctx.totalWins >= 1) grant('first_win');
    if (ctx.totalWins >= 10) grant('veteran');
    if (ctx.winStreakAfter >= 3) grant('streak_3');
    var stats = ctx.stats || {};
    if ((stats.kills || 0) >= 5) grant('ace');
    if ((stats.sixes || 0) >= 25) grant('lucky');
    if ((stats.beenKilled || 0) === 0) grant('flawless');
    if ((stats.beenKilled || 0) >= 3) grant('comeback');
    var levels = ctx.beatenAiLevels || [];
    for (var i = 0; i < levels.length; i++) {
      if (levels[i] === 4) { grant('master_slayer'); break; }
    }
  }
  return { fresh: fresh, all: list };
}

module.exports = {
  DEFINITIONS: DEFINITIONS,
  find: find,
  evaluateAchievements: evaluateAchievements
};
