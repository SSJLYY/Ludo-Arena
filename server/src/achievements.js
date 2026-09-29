/**
 * achievements.js — 成就系统（纯函数，服务端结算时调用）
 *
 * 解锁判定只看「本局结算后的累计数据 + 本局统计」，由 websocket.js 在
 * 对局结束落库时调用 evaluateAchievements()，新解锁的 id 随 game_over 推给前端。
 */

// 成就定义（数组顺序 = 成就墙展示顺序）
const DEFINITIONS = [
  { id: 'first_win', icon: '🥇', name: '首胜', desc: '赢下第一场对局' },
  { id: 'streak_3', icon: '🔥', name: '三连胜', desc: '连续赢下 3 场对局', goal: 3, stat: 'bestStreak' },
  { id: 'streak_5', icon: '⚡', name: '五连霸', desc: '连续赢下 5 场对局', goal: 5, stat: 'bestStreak' },
  { id: 'veteran', icon: '🏅', name: '常胜将军', desc: '累计赢下 10 场对局', goal: 10, stat: 'wins' },
  { id: 'centurion', icon: '🎖️', name: '百战沙场', desc: '累计完成 50 场对局', goal: 50, stat: 'games' },
  { id: 'ace', icon: '🎯', name: '王牌杀手', desc: '单局击落 5 架敌机', goal: 5, stat: 'bestKills' },
  { id: 'six_king', icon: '🎲', name: '六点狂魔', desc: '单局掷出 10 次六点' },
  { id: 'flawless', icon: '💎', name: '完美胜利', desc: '零被击落并获胜' },
  { id: 'comeback', icon: '💪', name: '绝地反击', desc: '被击落 3 架仍逆转获胜' },
  { id: 'master_slayer', icon: '⚔️', name: '大师克星', desc: '战胜困难难度的电脑' },
  // v22 事件型成就（非对局结算时机，由各系统调用 stats.unlockAchievements 解锁）
  { id: 'tournament_champ', icon: '👑', name: '锦标赛冠军', desc: '赢下一次全服锦标赛' },
  { id: 'season_champ', icon: '🌟', name: '赛季之王', desc: '登顶月度赛季榜第一' },
  { id: 'conqueror', icon: '🗺️', name: '全图制霸', desc: '通关全部 10 关 PVE' },
];

function find(id) {
  for (let i = 0; i < DEFINITIONS.length; i += 1) {
    if (DEFINITIONS[i].id === id) return DEFINITIONS[i];
  }
  return null;
}

/**
 * 结算一次对局后评估解锁。
 * @param {string[]} existing 已解锁 id 列表
 * @param {object} ctx {
 *   isWinner, totalWins, totalGames, winStreakAfter, bestStreak,
 *   stats: { kills, sixes, beenKilled },
 *   beatenAiLevels: number[] 获胜时对局中电脑座位的难度列表
 * }
 * @return {{ fresh: string[], all: string[] }}
 */
function evaluateAchievements(existing, ctx) {
  const have = {};
  const list = [];
  (existing || []).forEach((id) => {
    if (!have[id]) { have[id] = true; list.push(id); }
  });
  const fresh = [];
  function grant(id) {
    if (!have[id]) { have[id] = true; fresh.push(id); list.push(id); }
  }

  const c = ctx || {};
  const stats = c.stats || {};

  if (c.isWinner) {
    if ((c.totalWins || 0) >= 1) grant('first_win');
    if ((c.totalWins || 0) >= 10) grant('veteran');
    if ((c.winStreakAfter || 0) >= 3) grant('streak_3');
    if ((c.winStreakAfter || 0) >= 5) grant('streak_5');
    if ((stats.beenKilled || 0) === 0) grant('flawless');
    if ((stats.beenKilled || 0) >= 3) grant('comeback');
    if ((c.beatenAiLevels || []).some((lv) => Number(lv) >= 3)) grant('master_slayer');
  }
  if ((c.totalGames || 0) >= 50) grant('centurion');
  if ((stats.kills || 0) >= 5) grant('ace');
  if ((stats.sixes || 0) >= 10) grant('six_king');

  return { fresh, all: list };
}

/** 给前端用的完整成就墙（含已解锁标记） */
function wall(unlockedIds) {
  const set = {};
  (unlockedIds || []).forEach((id) => { set[id] = true; });
  return DEFINITIONS.map((d) => ({ ...d, unlocked: !!set[d.id] }));
}

module.exports = { DEFINITIONS, find, evaluateAchievements, wall };
