/**
 * season.js — v20 赛季结算（从 index.js 抽出，便于测试）
 *
 * 职责：已结束赛季的前三名结算 —— 发币 + 归档名人堂 + 赛季荣誉战报（v20 新增）。
 * DUP 保护双保险：名人堂同赛季只归档一次（发奖在归档前、归档失败即整季不再重发），
 * 自动结算另有 lastSettledSeason 游标（meta.json）。
 */

const stats = require('./stats');
const meta = require('./meta');
const audit = require('./audit');

/** 上一个自然月：'2026-09' -> '2026-08' */
function prevSeason(season) {
  const [y, m] = String(season).split('-').map(Number);
  const pm = m - 1;
  return pm >= 1 ? `${y}-${String(pm).padStart(2, '0')}` : `${y - 1}-12`;
}

/**
 * 结算某个已结束赛季：前 3 发币 + 归档名人堂 + 给获奖者发赛季荣誉战报。
 * 返回 {ok:true, season, awarded} | {ok:false, error:'ALREADY_SETTLED'|'EMPTY'}。
 */
function settleSeason(season) {
  if (meta.getHall().some((h) => h.season === season)) return { ok: false, error: 'ALREADY_SETTLED' };
  const top = stats.seasonTop(season, 3);
  if (!top.length) return { ok: false, error: 'EMPTY' };
  const bonus = [50, 30, 20];
  const awarded = [];
  top.forEach((p, i) => {
    stats.awardCoins(p.nick, bonus[i] || 10);
    awarded.push({ nick: p.nick, bonus: bonus[i] });
    // v20 赛季荣誉战报：让获奖玩家回访时知道「上月拿了第几名」
    meta.pushMail(p.nick, {
      kind: 'season', season, rank: i + 1, bonus: bonus[i] || 10,
    });
  });
  meta.addHallSeason(season, awarded);
  if (awarded[0]) stats.unlockAchievements(awarded[0].nick, ['season_champ']); // v22 赛季之王
  audit.log('season_settle', 'system', { season, awarded });
  return { ok: true, season, awarded };
}

/** 启动/每小时检查：进入新月且上月已结束时自动结算（游标防重） */
function autoSeasonSettle(reason) {
  try {
    const cur = stats.currentSeason();
    if (meta.getLastSettled() === cur) return null;
    const r = settleSeason(prevSeason(cur));
    meta.setLastSettled(cur);
    if (r.ok) console.log(`[season] 已自动结算 ${r.season}（${reason}）：` + r.awarded.map((a) => `${a.nick}+${a.bonus}`).join('、'));
    return r;
  } catch (e) {
    console.error('[season] auto settle failed:', e.message);
    return null;
  }
}

module.exports = { prevSeason, settleSeason, autoSeasonSettle };
