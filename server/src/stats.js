/**
 * stats.js — 战绩持久化（JSON 文件，零依赖）
 *
 * ⚠️ 为什么不是 SQLite：本宿主（CentOS 7 / 内核 3.10 + overlayfs）上 SQLite 任何日志模式
 *    （WAL / DELETE）、任何路径（挂载卷 / 容器 /tmp）建表即报 `disk I/O error`，
 *    是 fcntl 文件锁在老内核 overlay 上不被支持导致（与 nginx 写不了 pid 同源）。
 *    实测 fs.writeFileSync / rename 均正常，故改用 JSON 原子写，接口保持不变。
 *
 * 存储 ${STATS_DIR:-<server>/data}/stats.json（宿主机挂载卷，容器重建不丢）
 *   players: { nick -> {nick, games, wins, kills, beenKilled, lastPlay,
 *                       streak, bestStreak, sixes, bestKills, achievements:[],
 *                       coins, signDate, signStreak, skins:[], equipped} }
 *   games:   [ {id, endedAt, season, roomNo, results:[...]} ]  仅保留最近 MAX_GAMES 局
 * 首次运行若存在旧版 stats.db 则忽略（数据无法读出，留档即可）。
 */
const fs = require('fs');
const path = require('path');
const { evaluateAchievements, wall } = require('./achievements');
const { tierOf, winsToNext, tierProgress } = require('./tiers');

const DATA_DIR = process.env.STATS_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'stats.json');
const MAX_GAMES = 500; // 只留最近 500 局明细，防止文件无限膨胀

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }

let data = load();
let diskMtime = statMtime();

function statMtime() {
  try { return fs.statSync(DATA_FILE).mtimeMs; } catch (e) { return 0; }
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      players: raw && raw.players && typeof raw.players === 'object' ? raw.players : {},
      games: Array.isArray(raw && raw.games) ? raw.games : [],
      friendships: raw && raw.friendships && typeof raw.friendships === 'object' ? raw.friendships : {},
    };
  } catch (e) {
    // v15 兜底：主档损坏（断电/磁盘满留下的半截文件）时回退 .bak，再不行才空库
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE + '.bak', 'utf8'));
      console.error('[stats] stats.json 损坏，已从 .bak 恢复');
      return {
        players: raw && raw.players && typeof raw.players === 'object' ? raw.players : {},
        games: Array.isArray(raw && raw.games) ? raw.games : [],
        friendships: raw && raw.friendships && typeof raw.friendships === 'object' ? raw.friendships : {},
      };
    } catch (e2) {
      return { players: {}, games: [], friendships: {} };
    }
  }
}

/** 文件被外部改动（容器重启/其他进程写入）时自动重载，保证内存与磁盘一致 */
function ensureFresh() {
  const m = statMtime();
  if (m !== diskMtime) {
    data = load();
    diskMtime = m;
  }
}

/** 原子写：写临时文件后 rename（rename 在本宿主可用）；失败回退直接写 */
function save() {
  const str = JSON.stringify(data);
  const tmp = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, str);
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    try { fs.writeFileSync(DATA_FILE, str); } catch (e2) {
      console.error('[stats] save failed:', e2.message);
    }
  }
  // v15：写成功后异步留一份 .bak（文件小，直接同步复制也不贵；失败不影响主流程）
  try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch (e) { /* ignore */ }
  diskMtime = statMtime();
}

const nextId = () => (data.games.length ? data.games[data.games.length - 1].id + 1 : 1);

// ================= v8 社交留存：赛季 / 签到 / 皮肤商店 =================

/** 东八区日期串 YYYY-MM-DD（签到按北京时间算，避免跨日歧义） */
function dayStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000 + 8 * 3600000);
  return d.toISOString().slice(0, 10);
}
/** 当前赛季：自然月 YYYY-MM（每月 1 号切换） */
function currentSeason() {
  return dayStr().slice(0, 7);
}

/** 商店皮肤定义（price 单位：金币）。classic 免费默认拥有。
 *  colors 用于前端套用（CSS 变量 + 棋盘主色），仅展示用。 */
const SHOP_SKINS = [
  { id: 'classic', name: '经典极光', price: 0, desc: '默认明亮科技风', theme: '#6a5cff', board: '#f6f8ff' },
  { id: 'aurora', name: '极光紫', price: 50, desc: '紫青渐变玻璃', theme: '#9b6cff', board: '#f3ecff' },
  { id: 'sunset', name: '落日橙', price: 80, desc: '暖橙红氛围', theme: '#ff7a59', board: '#fff1ea' },
  { id: 'forest', name: '森野绿', price: 80, desc: '清新草木绿', theme: '#3fae7a', board: '#eafff4' },
  { id: 'midnight', name: '暗夜蓝', price: 120, desc: '深蓝星空', theme: '#4f7bff', board: '#e7ecff' },
];

// ================= P0 玩法扩展地基：道具/技能卡定义 =================
// 与 game-engine useItem 的 ITEM 体系对齐（bomb/shield/accel/swap），开局可携带注入对局。
// price 单位：金币。id 同时作为前端图标 key 与 game.items 字典 key。
const SHOP_PROPS = [
  { id: 'bomb', name: '炸弹', desc: '炸毁敌方一架在跑道上的飞机（安全格免疫）', price: 40 },
  { id: 'shield', name: '护盾', desc: '为己方所有在途飞机挂护盾，被撞时抵消', price: 30 },
  { id: 'accel', name: '加速', desc: '选定一架在途飞机免费前进 4 格', price: 30 },
  { id: 'swap', name: '换位', desc: '交换两架在跑道上的飞机位置', price: 50 },
];

// ================= v9 社交留存：好友系统 =================
function normalizeNick(n) { return String(n || '').trim().slice(0, 16); }
function addFriend(a, b) {
  a = normalizeNick(a); b = normalizeNick(b);
  if (!a || !b || a === b) return { ok: false, error: 'invalid' };
  ensureFresh();
  if (!data.friendships[a]) data.friendships[a] = [];
  if (!data.friendships[b]) data.friendships[b] = [];
  if (!data.friendships[a].includes(b)) data.friendships[a].push(b);
  if (!data.friendships[b].includes(a)) data.friendships[b].push(a);
  save();
  return { ok: true, friends: data.friendships[a] };
}
function removeFriend(a, b) {
  a = normalizeNick(a); b = normalizeNick(b);
  if (!a || !b) return { ok: false, error: 'invalid' };
  ensureFresh();
  if (data.friendships[a]) data.friendships[a] = data.friendships[a].filter((x) => x !== b);
  if (data.friendships[b]) data.friendships[b] = data.friendships[b].filter((x) => x !== a);
  save();
  return { ok: true };
}
function listFriends(nick) {
  nick = normalizeNick(nick);
  ensureFresh();
  return data.friendships[nick] || [];
}

/**
 * 记录一局结束，并评估段位/连胜/成就。
 * rows: [{seat, nick, color, rank, finishedCount, kills, beenKilled, sixes, isWinner}]
 * opts: { aiLevels: number[], season?: string }
 * @return {{fresh: Object<string,string[]>}} 每人新解锁的成就 id
 */
function recordGame(rows, roomNo, opts) {
  ensureFresh();
  const now = Date.now();
  const season = (opts && opts.season) || currentSeason();
  const results = [];
  const seen = new Set();
  const aiLevels = (opts && opts.aiLevels) || [];
  const freshMap = {};
  rows.forEach((p) => {
    const nick = String(p.nick || '').slice(0, 16);
    if (!nick || seen.has(nick)) return;
    seen.add(nick);
    const kills = p.kills || 0;
    const beenKilled = p.beenKilled || 0;
    const sixes = p.sixes || 0;
    const win = p.isWinner ? 1 : 0;
    results.push({
      nick, seat: p.seat || 0, color: p.color || '', rank: p.rank || 0,
      finishedCount: p.finishedCount || 0, kills, beenKilled, sixes, isWinner: !!p.isWinner,
    });
    const pl = data.players[nick] || {
      nick, games: 0, wins: 0, kills: 0, beenKilled: 0, lastPlay: 0,
      streak: 0, bestStreak: 0, sixes: 0, bestKills: 0, achievements: [],
      coins: 0, signDate: '', signStreak: 0, skins: ['classic'], equipped: 'classic', props: [],
    };
    pl.games += 1;
    pl.wins += win;
    pl.kills += kills;
    pl.beenKilled += beenKilled;
    pl.sixes = (pl.sixes || 0) + sixes;
    if (kills > (pl.bestKills || 0)) pl.bestKills = kills;
    pl.streak = win ? (pl.streak || 0) + 1 : 0;
    if (pl.streak > (pl.bestStreak || 0)) pl.bestStreak = pl.streak;
    pl.lastPlay = now;
    // 成就评估（基于结算后的累计数据）
    const ev = evaluateAchievements(pl.achievements, {
      isWinner: !!p.isWinner,
      totalWins: pl.wins,
      totalGames: pl.games,
      winStreakAfter: pl.streak,
      bestStreak: pl.bestStreak,
      stats: { kills, sixes, beenKilled },
      beatenAiLevels: win ? aiLevels : [],
    });
    pl.achievements = ev.all;
    if (ev.fresh.length) freshMap[nick] = ev.fresh;
    data.players[nick] = pl;
    // v33：任务进度必须在玩家对象落回 data.players 之后再推进，
    // 否则新玩家（首次对局）的每日/周任务会被静默丢弃。
    bumpWeekly(nick, !!p.isWinner, kills); // v13 周任务进度推进
    bumpDaily(nick, !!p.isWinner, kills);  // v33 每日任务进度推进（此前缺失，日常任务永远完不成）
  });
  if (!results.length) return { fresh: {} };

  data.games.push({ id: nextId(), endedAt: now, season, roomNo: String(roomNo || ''), results });
  if (data.games.length > MAX_GAMES) data.games = data.games.slice(-MAX_GAMES);
  save();

  // v19 战报推送（站内信）：对局战报 + 成就解锁战报（rows 仅含真人座位，AI 不发）。
  // 放在 recordGame 是因为 freshMap（新解锁成就）在这里才算得出来；失败不影响结算。
  try {
    const meta = require('./meta');
    const ach = require('./achievements');
    // v33：先收集全部信件再一次落盘（原实现每人一次 save，4 人局 = 4 次全量 meta.json 写）
    const mailItems = [];
    rows.forEach((r) => {
      mailItems.push({
        nick: r.nick,
        entry: {
          kind: 'game', roomNo: String(roomNo || ''), rank: r.rank, kills: r.kills,
          beenKilled: r.beenKilled, finishedCount: r.finishedCount,
          isWinner: !!r.isWinner, pveLevel: (opts && opts.pveLevel) || null, season,
        },
      });
      const fresh = freshMap[r.nick];
      if (fresh && fresh.length) {
        mailItems.push({
          nick: r.nick,
          entry: {
            kind: 'achievement', roomNo: String(roomNo || ''), season,
            achs: fresh.map((id) => { const a = ach.find(id); return { id, icon: a ? a.icon : '🎖️', name: a ? a.name : id }; }),
          },
        });
      }
    });
    meta.pushMailBatch(mailItems);
  } catch (e) { console.error('[mail] push failed:', e.message); }

  return { fresh: freshMap };
}

/** 战绩榜：按胜率 → 胜场 → 击落 排序，取前 N */
/** v24 荣誉徽标（对局场景可视化）：锦标赛冠军 👑 / 赛季之王 🌟。无档案返回 null。 */
function seatBadges(nick) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  const pl = key ? data.players[key] : null;
  if (!pl || !pl.achievements || !pl.achievements.length) return null;
  return {
    tournamentChamp: pl.achievements.includes('tournament_champ'),
    seasonKing: pl.achievements.includes('season_champ'),
  };
}

/** v23 全体玩家昵称（全服邮件用） */
function allNicks() {
  ensureFresh();
  return Object.keys(data.players);
}

/** v43 后台玩家总览：全维度简表（含凭证持有标记），按最近对局倒序 */
function adminNicks() {
  ensureFresh();
  return Object.values(data.players)
    .map((p) => ({ nick: p.nick, games: p.games || 0, wins: p.wins || 0, coins: p.coins || 0, lastPlay: p.lastPlay || 0, hasSecret: !!p.secret }))
    .sort((a, b) => (b.lastPlay || 0) - (a.lastPlay || 0));
}

/** v26 成就进度：可计数的成就附 cur/goal（事件型成就无进度，progress=null） */
function wallWithProgress(p) {
  const statOf = (k) => (p && p[k] !== undefined && p[k] !== null ? Number(p[k]) : 0);
  return wall(p.achievements || []).map((w) => {
    if (!w.goal || !w.stat) return Object.assign(w, { progress: null });
    return Object.assign(w, { progress: { cur: Math.min(statOf(w.stat), w.goal), goal: w.goal } });
  });
}

/**
 * v17 多维榜单：board = winRate（默认，同 topList）| kills | streak | sign。
 * 返回字段随榜单变化，前端按榜单渲染列。
 */
function topListBy(n, board) {
  ensureFresh();
  const all = Object.values(data.players);
  const played = (p) => (p.games || 0) > 0;
  let arr;
  if (board === 'kills') {
    arr = all.filter(played)
      .map((p) => ({ nick: p.nick, kills: p.kills || 0, games: p.games || 0, wins: p.wins || 0, badges: seatBadges(p.nick) }))
      .sort((a, b) => (b.kills - a.kills) || (b.wins - a.wins) || (b.games - a.games));
  } else if (board === 'streak') {
    arr = all.filter(played)
      .map((p) => ({ nick: p.nick, bestStreak: p.bestStreak || 0, wins: p.wins || 0, games: p.games || 0, badges: seatBadges(p.nick) }))
      .sort((a, b) => (b.bestStreak - a.bestStreak) || (b.wins - a.wins) || (b.games - a.games));
  } else if (board === 'sign') {
    arr = all.filter((p) => (p.signStreak || 0) > 0)
      .map((p) => ({ nick: p.nick, signStreak: p.signStreak || 0, lastPlay: p.lastPlay || 0, badges: seatBadges(p.nick) }))
      .sort((a, b) => (b.signStreak - a.signStreak) || (b.lastPlay - a.lastPlay));
  } else {
    return topList(n);
  }
  return arr.slice(0, Math.max(1, n || 10));
}

function topList(n) {
  ensureFresh();
  return Object.values(data.players)
    .map((p) => ({
      nick: p.nick,
      games: p.games,
      wins: p.wins,
      winRate: p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0,
      kills: p.kills,
      beenKilled: p.beenKilled,
      lastPlay: p.lastPlay,
      streak: p.streak || 0,
      badges: seatBadges(p.nick), // v26/v31 排行榜行透出荣誉徽标
      tier: tierOf(p.wins).id,
      tierName: tierOf(p.wins).name,
      tierIcon: tierOf(p.wins).icon,
    }))
    .sort((a, b) => (b.winRate - a.winRate) || (b.wins - a.wins) || (b.kills - a.kills))
    .slice(0, Math.max(1, n || 10));
}

/**
 * 赛季榜：从最近 MAX_GAMES 局里过滤本赛季（或指定 season），按 nick 聚合
 * 胜场 / 胜率 / 击落，取前 N。
 */
function seasonTop(season, n) {
  ensureFresh();
  const s = season || currentSeason();
  const agg = {};
  for (let i = data.games.length - 1; i >= 0; i -= 1) {
    const g = data.games[i];
    if (g.season !== s) continue;
    g.results.forEach((r) => {
      if (!agg[r.nick]) agg[r.nick] = { nick: r.nick, games: 0, wins: 0, kills: 0 };
      agg[r.nick].games += 1;
      if (r.isWinner) agg[r.nick].wins += 1;
      agg[r.nick].kills += (r.kills || 0);
    });
  }
  return Object.values(agg)
    .map((x) => Object.assign(x, { winRate: x.games > 0 ? Math.round((x.wins / x.games) * 100) : 0 }))
    .sort((a, b) => (b.winRate - a.winRate) || (b.wins - a.wins) || (b.kills - a.kills))
    .slice(0, Math.max(1, n || 10));
}

/** 每日签到：今日未签则发放金币（连签加成）。返回最新状态。 */
function sign(nick) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  if (!key) return { ok: false, error: 'NICK_REQUIRED' };
  const today = dayStr();
  const yest = dayStr(-1);
  const pl = data.players[key] || {
    nick: key, games: 0, wins: 0, kills: 0, beenKilled: 0, lastPlay: 0,
    streak: 0, bestStreak: 0, sixes: 0, bestKills: 0, achievements: [],
    coins: 0, signDate: '', signStreak: 0, skins: ['classic'], equipped: 'classic', props: [],
  };
  if (pl.signDate === today) {
    return { ok: true, signed: false, coins: pl.coins, streak: pl.signStreak || 0, today };
  }
  const streak = pl.signDate === yest ? (pl.signStreak || 0) + 1 : 1;
  const reward = 10 + Math.min(streak - 1, 6) * 2; // 连签每天多 2 金币，封顶 +12
  pl.signDate = today;
  pl.signStreak = streak;
  pl.coins = (pl.coins || 0) + reward;
  data.players[key] = pl;
  save();
  return { ok: true, signed: true, reward, coins: pl.coins, streak, today };
}

/** 购买皮肤：金币足够且未拥有则扣费并加入 skins。 */
function buySkin(nick, id) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  if (!key) return { ok: false, error: 'NICK_REQUIRED' };
  const skin = SHOP_SKINS.find((s) => s.id === id);
  if (!skin) return { ok: false, error: 'SKIN_NOT_FOUND' };
  const pl = data.players[key] || {
    nick: key, games: 0, wins: 0, kills: 0, beenKilled: 0, lastPlay: 0,
    streak: 0, bestStreak: 0, sixes: 0, bestKills: 0, achievements: [],
    coins: 0, signDate: '', signStreak: 0, skins: ['classic'], equipped: 'classic', props: [],
  };
  if ((pl.skins || []).indexOf(id) >= 0) return { ok: false, error: 'OWNED' };
  if ((pl.coins || 0) < skin.price) return { ok: false, error: 'COINS_NOT_ENOUGH', need: skin.price };
  pl.coins = (pl.coins || 0) - skin.price;
  pl.skins = pl.skins || ['classic'];
  pl.skins.push(id);
  if (!pl.equipped) pl.equipped = id;
  data.players[key] = pl;
  save();
  return { ok: true, coins: pl.coins, owned: pl.skins, equipped: pl.equipped };
}

/** 装备皮肤（必须已拥有）。 */
function equipSkin(nick, id) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  if (!key) return { ok: false, error: 'NICK_REQUIRED' };
  const pl = data.players[key];
  if (!pl) return { ok: false, error: 'NO_PLAYER' };
  if ((pl.skins || []).indexOf(id) < 0) return { ok: false, error: 'NOT_OWNED' };
  pl.equipped = id;
  data.players[key] = pl;
  save();
  return { ok: true, equipped: id };
}

/** 个人战绩：汇总 + 最近 20 局明细 + 社交字段 */
function playerStats(nick) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  const p = data.players[key];
  if (!p) return null;
  const history = [];
  for (let i = data.games.length - 1; i >= 0 && history.length < 20; i -= 1) {
    const r = data.games[i].results.find((x) => x.nick === key);
    if (r) {
      history.push({
        endedAt: data.games[i].endedAt, season: data.games[i].season, color: r.color, rank: r.rank,
        finishedCount: r.finishedCount, kills: r.kills, beenKilled: r.beenKilled,
        isWinner: !!r.isWinner,
      });
    }
  }
  const tier = tierOf(p.wins);
  return {
    nick: p.nick,
    games: p.games,
    wins: p.wins,
    winRate: p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0,
    kills: p.kills,
    beenKilled: p.beenKilled,
    lastPlay: p.lastPlay,
    streak: p.streak || 0,
    bestStreak: p.bestStreak || 0,
    bestKills: p.bestKills || 0,
    sixes: p.sixes || 0,
    tier: tier.id,
    tierName: tier.name,
    tierIcon: tier.icon,
    tierColor: tier.color,
    winsToNext: winsToNext(p.wins),
    tierProgress: tierProgress(p.wins),
    achievements: p.achievements || [],
    wall: wallWithProgress(p),
    history,
    // v8 社交留存
    coins: p.coins || 0,
    diamonds: p.diamonds || 0, // v13 钻石
    sub: subState(key), // v13 订阅状态
    signDate: p.signDate || '',
    signStreak: p.signStreak || 0,
    skins: p.skins || ['classic'],
    equipped: p.equipped || 'classic',
    props: p.props || [],
    season: currentSeason(),
    daily: dailyState(key),
    weekly: weeklyState(key), // v13 周任务
  };
}

// ================= v12 每日任务（留存核心） =================
function dailyState(nick) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  if (!key) return { date: dayStr(), games: 0, wins: 0, kills: 0, claimed: false, tasks: [] };
  const p = data.players[key];
  if (!p || !p.daily || p.daily.date !== dayStr()) {
    return { date: dayStr(), games: 0, wins: 0, kills: 0, claimed: false, tasks: DAILY_TASKS(0, 0, 0) };
  }
  const t = p.daily;
  return { date: t.date, games: t.games, wins: t.wins, kills: t.kills, tour: t.tour || 0, claimed: !!t.claimed, tasks: DAILY_TASKS(t.games, t.wins, t.kills, t.tour || 0) };
}
function DAILY_TASKS(games, wins, kills, tour) {
  return [
    { id: 'play1', name: '今日首战', desc: '完成 1 局对局', done: games >= 1, reward: '🪙5' },
    { id: 'win1', name: '旗开得胜', desc: '赢下 1 局', done: wins >= 1, reward: '🪙8' },
    { id: 'kill3', name: '空战王牌', desc: '今日累计击落 3 架', done: kills >= 3, reward: '🎁 道具卡' },
    { id: 'tour1', name: '锦标赛之旅', desc: '完成 1 场锦标赛对局', done: (tour || 0) >= 1, reward: '🪙10' },
  ];
}
/** v28 锦标赛对局计入每日任务（锦标赛对局结束时由 websocket 钩子调用） */
function bumpDailyTournament(nick) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  const p = data.players[key] || blankPlayer(key);
  p.daily = p.daily || { date: dayStr(), games: 0, wins: 0, kills: 0, claimed: false };
  if (p.daily.date !== dayStr()) p.daily = { date: dayStr(), games: 0, wins: 0, kills: 0, claimed: false };
  p.daily.tour = (p.daily.tour || 0) + 1;
  data.players[key] = p;
  save();
}

function claimDaily(nick) {
  const st = dailyState(nick);
  if (!st) return { ok: false, error: 'NICK_REQUIRED' };
  if (st.claimed) return { ok: true, claimed: true, already: true };
  const done = st.tasks.filter((t) => t.done);
  if (!done.length) return { ok: false, error: 'NO_TASK_DONE' };
  const p = data.players[String(nick).slice(0, 16)];
  if (!p) return { ok: false, error: 'NO_TASK_DONE' };
  if (!p.daily) p.daily = { date: dayStr(), games: 0, wins: 0, kills: 0, claimed: false };
  p.daily.claimed = true;
  const coins = (done.find((t) => t.id === 'play1') ? 5 : 0) + (done.find((t) => t.id === 'win1') ? 8 : 0) + (done.find((t) => t.id === 'tour1') ? 10 : 0);
  if (coins) p.coins = (p.coins || 0) + coins;
  let prop = null;
  p.props = p.props || [];
  if (done.find((t) => t.id === 'kill3')) {
    // 掉落池必须与 game-engine 的 useItem 支持项一致，否则开局携带会失效
    const pool = SHOP_PROPS.map((x) => x.id);
    prop = pool[Math.floor(Math.random() * pool.length)];
    const ex = p.props.find((x) => x.id === prop);
    if (ex) ex.count += 1; else p.props.push({ id: prop, count: 1 });
  }
  save();
  return { ok: true, coins: p.coins || 0, prop, claimed: true };
}

/** 发放道具到背包（签到/对局/商城掉落共用）。props 存 [{id,count}]。 */
function addProps(nick, id, n) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  if (!key) return { ok: false, error: 'NICK_REQUIRED' };
  if (!SHOP_PROPS.find((p) => p.id === id)) return { ok: false, error: 'PROP_NOT_FOUND' };
  const pl = data.players[key] || {
    nick: key, games: 0, wins: 0, kills: 0, beenKilled: 0, lastPlay: 0,
    streak: 0, bestStreak: 0, sixes: 0, bestKills: 0, achievements: [],
    coins: 0, signDate: '', signStreak: 0, skins: ['classic'], equipped: 'classic', props: [],
  };
  pl.props = pl.props || [];
  const ex = pl.props.find((x) => x.id === id);
  if (ex) ex.count += (n || 1); else pl.props.push({ id, count: (n || 1) });
  data.players[key] = pl;
  save();
  return { ok: true, props: pl.props };
}

/** 开局携带：从背包扣减指定道具（items: [{id,count}]），返回实际扣减成功的 id 列表 */
function consumeProps(nick, items) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  if (!key) return [];
  const p = data.players[key];
  if (!p) return [];
  p.props = p.props || [];
  const used = [];
  (items || []).forEach((it) => {
    const ex = p.props.find((x) => x.id === it.id);
    if (!ex) return;
    const n = Math.min(ex.count, it.count || 1);
    if (n <= 0) return;
    ex.count -= n;
    used.push(it.id);
    if (ex.count <= 0) p.props = p.props.filter((x) => x !== ex);
  });
  save();
  return used;
}

/** 购买道具卡：扣金币 + 入背包 */
function buyProp(nick, id) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  if (!key) return { ok: false, error: 'NICK_REQUIRED' };
  const prop = SHOP_PROPS.find((p) => p.id === id);
  if (!prop) return { ok: false, error: 'PROP_NOT_FOUND' };
  const pl = data.players[key] || {
    nick: key, games: 0, wins: 0, kills: 0, beenKilled: 0, lastPlay: 0,
    streak: 0, bestStreak: 0, sixes: 0, bestKills: 0, achievements: [],
    coins: 0, signDate: '', signStreak: 0, skins: ['classic'], equipped: 'classic', props: [],
  };
  if ((pl.coins || 0) < prop.price) return { ok: false, error: 'COINS_NOT_ENOUGH', need: prop.price };
  pl.coins = (pl.coins || 0) - prop.price;
  pl.props = pl.props || [];
  const ex = pl.props.find((x) => x.id === id);
  if (ex) ex.count += 1; else pl.props.push({ id, count: 1 });
  data.players[key] = pl;
  save();
  return { ok: true, coins: pl.coins, props: pl.props };
}

/** v33 金额归一化：只接受整数，负数一律拒绝（防运营接口传错造出负金币/浮点误差） */
function normAmount(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 0) return null;
  return v;
}

/** 运营/赛季奖励发币 */
function awardCoins(nick, n) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  if (!key) return { ok: false, error: 'NICK_REQUIRED' };
  const amount = normAmount(n);
  if (amount === null) return { ok: false, error: 'AMOUNT_INVALID' };
  const pl = data.players[key] || blankPlayer(key);
  pl.coins = (pl.coins || 0) + amount;
  data.players[key] = pl;
  save();
  return { ok: true, coins: pl.coins };
}

/** 发放钻石（订阅每日奖励 / 看广告等） */
function awardDiamonds(nick, n) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  if (!key) return { ok: false, error: 'NICK_REQUIRED' };
  const amount = normAmount(n);
  if (amount === null) return { ok: false, error: 'AMOUNT_INVALID' };
  const pl = data.players[key] || blankPlayer(key);
  pl.diamonds = (pl.diamonds || 0) + amount;
  data.players[key] = pl;
  save();
  return { ok: true, diamonds: pl.diamonds };
}

// ================= v12 PVE 闯关 =================
/**
 * 10 关递进：难度 + 让先（AI 预置飞机已在跑道上，rp 越大让得越多）。
 * handicap: { planes: 让先飞机数, rp: 预置位置 }
 */
const PVE_LEVELS = [
  { lv: 1, name: '新兵训练场', aiLevel: 1, handicap: null, coins: 5 },
  { lv: 2, name: '云端初鸣', aiLevel: 1, handicap: null, coins: 6 },
  { lv: 3, name: '编队交锋', aiLevel: 2, handicap: null, coins: 8 },
  { lv: 4, name: '被抢先机', aiLevel: 2, handicap: { planes: 1, rp: 20 }, coins: 10 },
  { lv: 5, name: '双机压境', aiLevel: 2, handicap: { planes: 2, rp: 20 }, coins: 12 },
  { lv: 6, name: '老谋深算', aiLevel: 3, handicap: { planes: 1, rp: 25 }, coins: 15 },
  { lv: 7, name: '铁壁合围', aiLevel: 3, handicap: { planes: 2, rp: 25 }, coins: 18 },
  { lv: 8, name: '绝地反击', aiLevel: 3, handicap: { planes: 2, rp: 35 }, coins: 22 },
  { lv: 9, name: '大师对局', aiLevel: 4, handicap: { planes: 2, rp: 30 }, coins: 28 },
  { lv: 10, name: '无解之战', aiLevel: 4, handicap: { planes: 3, rp: 40 }, coins: 40 },
];

/** 玩家闯关进度：cleared = 已通过的最高关，next = 可挑战关卡 */
function pveState(nick) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  const p = key ? data.players[key] : null;
  const cleared = (p && p.pve && Number(p.pve.cleared)) || 0;
  return {
    cleared,
    next: Math.min(cleared + 1, PVE_LEVELS.length),
    total: PVE_LEVELS.length,
    levels: PVE_LEVELS.map((L) => ({
      lv: L.lv, name: L.name, aiLevel: L.aiLevel, coins: L.coins,
      handicap: L.handicap ? `AI ${L.handicap.planes} 机已在第 ${L.handicap.rp + 1} 格` : '公平开局',
      unlocked: L.lv <= cleared + 1,
      passed: L.lv <= cleared,
    })),
  };
}

function pveConfig(lv) {
  return PVE_LEVELS.find((L) => L.lv === Number(lv)) || null;
}

/** 通关记录：只在打过的关 = cleared+1 时推进，防跳关刷币 */
function pvePass(nick, lv) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  if (!key) return { ok: false, error: 'NICK_REQUIRED' };
  const L = pveConfig(lv);
  if (!L) return { ok: false, error: 'LEVEL_NOT_FOUND' };
  const pl = data.players[key] || blankPlayer(key);
  pl.pve = pl.pve || { cleared: 0 };
  if (L.lv !== pl.pve.cleared + 1) {
    data.players[key] = pl;
    return { ok: true, repeat: true, cleared: pl.pve.cleared, coins: pl.coins || 0 };
  }
  pl.pve.cleared = L.lv;
  pl.coins = (pl.coins || 0) + L.coins;
  data.players[key] = pl;
  save();
  if (L.lv >= PVE_LEVELS.length) unlockAchievements(key, ['conqueror']); // v22 全图制霸
  return { ok: true, cleared: pl.pve.cleared, gained: L.coins, coins: pl.coins, name: L.name };
}

// ================= v12 每日残局（精确到达解谜） =================
/** 确定性随机：同一天全站同一道题 */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * 生成当日残局：4 架飞机各差 N 格到家，给一串骰子，要求全部「精确到达」。
 * 造题方式 = 先随机拆解出解法再打乱骰序，保证一定有解。
 */
function puzzleToday(dateStr) {
  const date = dateStr || dayStr();
  const rnd = mulberry32(seedOf('flychess-puzzle-' + date));
  const rem = [];
  const dice = [];
  for (let i = 0; i < 4; i++) {
    let need = 4 + Math.floor(rnd() * 9); // 4..12 格
    rem.push(need);
    while (need > 0) {
      const step = need <= 6 ? need : 1 + Math.floor(rnd() * Math.min(6, need - 1));
      dice.push(step);
      need -= step;
    }
  }
  // Fisher-Yates 洗牌（同种子结果固定）
  for (let i = dice.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = dice[i]; dice[i] = dice[j]; dice[j] = t;
  }
  return { date, rem, dice, reward: { coins: 12, prop: true } };
}

function puzzleState(nick) {
  ensureFresh();
  const pz = puzzleToday();
  const key = String(nick || '').slice(0, 16);
  const p = key ? data.players[key] : null;
  const solvedDate = (p && p.puzzle && p.puzzle.date) || '';
  return Object.assign({}, pz, { solved: solvedDate === pz.date });
}

/** 通关领奖：服务端复算一遍玩家提交的分配方案，防前端伪造 */
function puzzleClaim(nick, moves) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  if (!key) return { ok: false, error: 'NICK_REQUIRED' };
  const pz = puzzleToday();
  const pl = data.players[key] || blankPlayer(key);
  pl.puzzle = pl.puzzle || { date: '', streak: 0 };
  if (pl.puzzle.date === pz.date) return { ok: true, already: true, coins: pl.coins || 0 };

  // 校验：moves = [planeIndex,...]，长度须等于骰子数，按序消耗
  if (!Array.isArray(moves) || moves.length !== pz.dice.length) return { ok: false, error: 'BAD_SOLUTION' };
  const rem = pz.rem.slice();
  for (let i = 0; i < moves.length; i++) {
    const pi = Number(moves[i]);
    if (!(pi >= 0 && pi < 4)) return { ok: false, error: 'BAD_SOLUTION' };
    const d = pz.dice[i];
    if (rem[pi] === 0) return { ok: false, error: 'BAD_SOLUTION' }; // 已到家不能再动
    rem[pi] = d > rem[pi] ? d - rem[pi] : rem[pi] - d; // 超出则回弹
  }
  if (rem.some((r) => r !== 0)) return { ok: false, error: 'NOT_SOLVED' };

  pl.puzzle.date = pz.date;
  pl.puzzle.streak = (pl.puzzle.streak || 0) + 1;
  pl.coins = (pl.coins || 0) + pz.reward.coins;
  pl.props = pl.props || [];
  const pool = SHOP_PROPS.map((x) => x.id);
  const prop = pool[Math.floor(Math.random() * pool.length)];
  const ex = pl.props.find((x) => x.id === prop);
  if (ex) ex.count += 1; else pl.props.push({ id: prop, count: 1 });
  data.players[key] = pl;
  save();
  return { ok: true, coins: pl.coins, gained: pz.reward.coins, prop, streak: pl.puzzle.streak };
}

/** 新建玩家白板（各处 fallback 统一走这里，别再散着写） */
function blankPlayer(key) {
  return {
    nick: key, games: 0, wins: 0, kills: 0, beenKilled: 0, lastPlay: 0,
    streak: 0, bestStreak: 0, sixes: 0, bestKills: 0, achievements: [],
    coins: 0, signDate: '', signStreak: 0, skins: ['classic'], equipped: 'classic', props: [],
    diamonds: 0, // v13 钻石（月卡/季卡每日发放，商城高级物品用）
    sub: null,    // v13 订阅：{type:'month'|'season', expire:timestamp}
    subGrantDate: '', // v13 订阅每日钻石发放日期（防重复）
    weekly: null, // v13 周任务进度 {week, games, wins, kills, claimed}
    transferDate: '', transferToday: 0, // v13 金币转账每日限额
    secret: '',   // v15 账号凭证（服务端生成后由客户端持有；转账/商城等财富操作必须出示）
  };
}

// ================= v15 账号凭证（防冒名） =================
// 现状：财富操作只认昵称，任何人 curl 传别人昵称即可转走对方金币。
// 方案：客户端本地生成随机凭证并随建房/加入出示 → 服务端首次认领（claim）写入档案；
//       此后所有财富/社交变更操作必须出示匹配凭证，否则拒绝并记审计。
// 旧玩家档案无凭证：首次出示即认领，平滑迁移；多设备可在设置页复制凭证带走。

/** 首次认领：仅在档案还没有凭证且 token 非空时写入（游戏对局永不因凭证失败而阻断）。
 *  createIfMissing：建房/加入等首次触达场景顺手建档（真实玩家几乎必然先入房再碰财富操作，
 *  把认领窗口压到最短）；默认 false。 */
function claimSecret(nick, token, createIfMissing) {
  const key = String(nick || '').trim().slice(0, 16);
  const t = String(token || '').trim();
  if (!key || !t) return false;
  ensureFresh();
  let pl = data.players[key];
  if (!pl) {
    if (!createIfMissing) return false;
    pl = blankPlayer(key);
    data.players[key] = pl;
  }
  if (pl.secret) return false;    // 已有凭证：绝不覆盖
  pl.secret = t;
  data.players[key] = pl;
  save();
  return true;
}

/**
 * 校验（认领即通过）：财富操作入口统一走这里。
 * 返回 {ok:true, claimed?:true} 或 {ok:false, error:'AUTH_REQUIRED'|'AUTH_FAILED'}。
 */
function verifySecret(nick, token) {
  const key = String(nick || '').trim().slice(0, 16);
  const t = String(token || '').trim();
  ensureFresh();
  const pl = data.players[key];
  if (!pl || !pl.secret) {
    if (!t) return { ok: false, error: 'AUTH_REQUIRED' };
    // v33 追溯能力：认领即永久占有该昵称的财富入口，记下认领时间。
    // 老昵称若被他人抢先认领（本游戏无注册体系，先到先得），后台可通过
    // /api/admin/secret-info 查到 secretSetAt 与历史局数，再用 secret-reset 回滚给真主。
    // 注：未对凭证做最低长度限制——存量脚本/测试用例使用短凭证，限制会直接打断它们。
    if (!pl) {
      // 全新玩家：建档案并认领（与 blankPlayer 默认一致）
      data.players[key] = blankPlayer(key);
      data.players[key].secret = t;
      data.players[key].secretSetAt = Date.now();
      save();
      return { ok: true, claimed: true };
    }
    pl.secret = t;
    pl.secretSetAt = Date.now();
    save();
    return { ok: true, claimed: true };
  }
  if (!t || t !== pl.secret) return { ok: false, error: 'AUTH_FAILED' };
  return { ok: true };
}

/** v33 后台追溯用：凭证认领时间（老昵称被抢注时可据此判断是否回滚） */
function secretInfo(nick) {
  const key = String(nick || '').trim().slice(0, 16);
  ensureFresh();
  const pl = data.players[key];
  if (!pl) return { ok: false, error: 'NO_PLAYER' };
  return { ok: true, nick: key, hasSecret: !!pl.secret, secretSetAt: pl.secretSetAt || null, games: pl.games || 0 };
}

/** 后台重置（凭证丢失找回）：清掉后下一次出示即重新认领 */
function resetSecret(nick) {
  const key = String(nick || '').trim().slice(0, 16);
  ensureFresh();
  const pl = data.players[key];
  if (!pl || !pl.secret) return false;
  pl.secret = '';
  pl.secretSetAt = 0;
  data.players[key] = pl;
  save();
  return true;
}

/** v22 事件型成就解锁（锦标赛冠军/赛季冠军等非对局结算时机）。返回新解锁的 id 列表。 */
function unlockAchievements(nick, ids) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!key || !list.length) return { ok: false, fresh: [] };
  const pl = data.players[key] || blankPlayer(key);
  pl.achievements = pl.achievements || [];
  const fresh = list.filter((id) => !pl.achievements.includes(id));
  if (!fresh.length) { data.players[key] = pl; return { ok: true, fresh: [] }; }
  pl.achievements = pl.achievements.concat(fresh);
  data.players[key] = pl;
  save();
  return { ok: true, fresh };
}

/**
 * v16 昵称占用校验：已有凭证的昵称（被人认领过）建房/加入必须出示匹配凭证，
 * 防止冒名开局故意输棋毁人胜率、冒名聊天/举报。未占用昵称：
 *   - 出示 token → 顺手认领（建档）；
 *   - 未出示 → 放行（兼容旧客户端），但不认领。
 * 返回 {ok:true, claimed?:true} | {ok:false, error:'NICK_TAKEN'}。
 */
function verifyNickOwnership(nick, token) {
  const key = String(nick || '').trim().slice(0, 16);
  const t = String(token || '').trim();
  if (!key) return { ok: true };
  ensureFresh();
  const pl = data.players[key];
  if (pl && pl.secret) {
    return (t && t === pl.secret) ? { ok: true } : { ok: false, error: 'NICK_TAKEN' };
  }
  if (t) {
    claimSecret(key, t, true);
    return { ok: true, claimed: true };
  }
  return { ok: true };
}

// ================= v13 月卡 / 季卡订阅 =================
const SUB_DAYS = { month: 30, season: 90 };
const SUB_DAILY_DIAMOND = { month: 30, season: 100 };

/** 开通订阅（演示版：直接激活，真实环境应走支付回调后调用本函数） */
function subscribe(nick, type) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  if (!key) return { ok: false, error: 'NICK_REQUIRED' };
  if (!SUB_DAYS[type]) return { ok: false, error: 'BAD_TYPE' };
  const pl = data.players[key] || blankPlayer(key);
  const now = Date.now();
  // 续费：在旧到期日基础上顺延，而非从今天重算
  const base = (pl.sub && pl.sub.expire > now) ? pl.sub.expire : now;
  pl.sub = { type, expire: base + SUB_DAYS[type] * 86400000 };
  data.players[key] = pl;
  save();
  return { ok: true, sub: pl.sub };
}
/** 订阅者每日登录发放钻石（每天一次），返回本次发放额 */
function ensureSubGrant(nick) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  if (!key) return { ok: false };
  const pl = data.players[key];
  if (!pl || !pl.sub || pl.sub.expire <= Date.now()) return { ok: false, subscribed: false };
  const today = dayStr();
  if (pl.subGrantDate === today) return { ok: true, subscribed: true, granted: 0, diamonds: pl.diamonds || 0 };
  const amt = SUB_DAILY_DIAMOND[pl.sub.type] || 0;
  pl.diamonds = (pl.diamonds || 0) + amt;
  pl.subGrantDate = today;
  data.players[key] = pl;
  save();
  return { ok: true, subscribed: true, granted: amt, diamonds: pl.diamonds };
}
/** 当前订阅状态（前端展示用） */
function subState(nick) {
  const key = String(nick || '').slice(0, 16);
  const pl = key ? data.players[key] : null;
  if (!pl || !pl.sub || pl.sub.expire <= Date.now()) return { active: false };
  return { active: true, type: pl.sub.type, expire: pl.sub.expire, daysLeft: Math.ceil((pl.sub.expire - Date.now()) / 86400000) };
}

// ================= v13 周任务（留存） =================
function weekKey() {
  // 以自然周（周一为起点）做 key：取本周一日期
  const d = new Date(Date.now() + 8 * 3600000);
  const dow = (d.getUTCDay() + 6) % 7; // 周一=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function WEEKLY_TASKS(games, wins, kills) {
  return [
    { id: 'wplay', name: '周常出勤', desc: '完成 5 局对局', done: games >= 5, reward: '🪙30' },
    { id: 'wwin', name: '周常凯旋', desc: '赢下 3 局', done: wins >= 3, reward: '🪙40' },
    { id: 'wkill', name: '周常空战', desc: '累计击落 10 架', done: kills >= 10, reward: '🎁 道具×2' },
  ];
}
function weeklyState(nick) {
  ensureFresh();
  const key = String(nick || '').slice(0, 16);
  const wk = weekKey();
  const p = data.players[key];
  if (!p || !p.weekly || p.weekly.week !== wk) {
    return { week: wk, games: 0, wins: 0, kills: 0, claimed: false, tasks: WEEKLY_TASKS(0, 0, 0) };
  }
  const t = p.weekly;
  return { week: wk, games: t.games, wins: t.wins, kills: t.kills, claimed: !!t.claimed, tasks: WEEKLY_TASKS(t.games, t.wins, t.kills) };
}
function claimWeekly(nick) {
  const st = weeklyState(nick);
  if (st.claimed) return { ok: true, claimed: true, already: true };
  const done = st.tasks.filter((t) => t.done);
  if (!done.length) return { ok: false, error: 'NO_TASK_DONE' };
  const p = data.players[String(nick).slice(0, 16)];
  if (!p) return { ok: false, error: 'NO_PLAYER' };
  if (!p.weekly) p.weekly = { week: weekKey(), games: 0, wins: 0, kills: 0, claimed: false };
  p.weekly.claimed = true;
  const coins = (done.find((t) => t.id === 'wplay') ? 30 : 0) + (done.find((t) => t.id === 'wwin') ? 40 : 0);
  if (coins) p.coins = (p.coins || 0) + coins;
  p.props = p.props || [];
  if (done.find((t) => t.id === 'wkill')) {
    const pool = SHOP_PROPS.map((x) => x.id);
    for (let i = 0; i < 2; i += 1) {
      const prop = pool[Math.floor(Math.random() * pool.length)];
      const ex = p.props.find((x) => x.id === prop);
      if (ex) ex.count += 1; else p.props.push({ id: prop, count: 1 });
    }
  }
  save();
  return { ok: true, coins: p.coins || 0, claimed: true };
}
/**
 * v33 P0 修复：对局结束后同步推进每日任务进度（recordGame 内调用）。
 * 此前 recordGame 只 bumpWeekly，daily.games/wins/kills 永远为 0，
 * 导致「今日首战 / 旗开得胜 / 空战王牌」三项恒未完成、claimDaily 恒返回 NO_TASK_DONE。
 * 注意：本函数不落盘（由 recordGame 末尾统一 save），避免一局多次全量写。
 */
function bumpDaily(nick, isWin, kills) {
  const key = String(nick || '').slice(0, 16);
  if (!key) return;
  const p = data.players[key];
  if (!p) return;
  const d = dayStr();
  if (!p.daily || p.daily.date !== d) {
    p.daily = { date: d, games: 0, wins: 0, kills: 0, tour: 0, claimed: false };
  }
  p.daily.games = (p.daily.games || 0) + 1;
  if (isWin) p.daily.wins = (p.daily.wins || 0) + 1;
  p.daily.kills = (p.daily.kills || 0) + (kills || 0);
}

/** 对局结束后同步推进周任务进度（recordGame 内调用） */
function bumpWeekly(nick, isWin, kills) {
  const key = String(nick || '').slice(0, 16);
  if (!key) return;
  const p = data.players[key];
  if (!p) return;
  const wk = weekKey();
  if (!p.weekly || p.weekly.week !== wk) p.weekly = { week: wk, games: 0, wins: 0, kills: 0, claimed: false };
  p.weekly.games += 1;
  if (isWin) p.weekly.wins += 1;
  p.weekly.kills = (p.weekly.kills || 0) + (kills || 0);
}

// ================= v13 金币转账（好友赠币，带每日限额） =================
const TRANSFER_DAILY_LIMIT = 200;
function transferCoins(from, to, amount) {
  ensureFresh();
  from = normalizeNick(from); to = normalizeNick(to);
  amount = Math.floor(Number(amount) || 0);
  if (!from || !to || from === to) return { ok: false, error: 'INVALID' };
  if (amount <= 0 || amount > 1000) return { ok: false, error: 'AMOUNT_INVALID' };
  const pf = data.players[from], pt = data.players[to];
  if (!pf || !pt) return { ok: false, error: 'NO_PLAYER' };
  if ((pf.coins || 0) < amount) return { ok: false, error: 'COINS_NOT_ENOUGH' };
  const today = dayStr();
  if (pf.transferDate !== today) { pf.transferDate = today; pf.transferToday = 0; }
  if (pf.transferToday + amount > TRANSFER_DAILY_LIMIT) return { ok: false, error: 'DAILY_LIMIT', left: TRANSFER_DAILY_LIMIT - pf.transferToday };
  pf.coins -= amount;
  pf.transferToday += amount;
  pt.coins = (pt.coins || 0) + amount;
  save();
  return { ok: true, fromCoins: pf.coins, toCoins: pt.coins, transferred: amount };
}

/** 好友列表（带在线状态标记，online 由 WS 层注入） */
/** v30 反查好友：把 nick 加为好友的所有玩家（好友上线提醒用） */
function friendsOf(nick) {
  ensureFresh();
  const key = String(nick || '').trim().slice(0, 16);
  const out = [];
  for (const [owner, list] of Object.entries(data.friendships)) {
    if (Array.isArray(list) && list.includes(key) && owner !== key) out.push(owner);
  }
  return out;
}

function friendListWithOnline(nick, onlineSet) {
  const list = listFriends(nick);
  const set = onlineSet || new Set();
  return list.map((f) => ({ nick: f, online: set.has(f) }));
}

module.exports = {
  adminNicks,
  recordGame, topList, topListBy, playerStats, seasonTop, sign, buySkin, equipSkin,
  currentSeason, dayStr, SHOP_SKINS, SHOP_PROPS, addProps, consumeProps, buyProp,
  awardCoins, awardDiamonds, dailyState, claimDaily,
  addFriend, removeFriend, listFriends, friendListWithOnline,
  subscribe, ensureSubGrant, subState,
  weeklyState, claimWeekly, bumpWeekly,
  transferCoins,
  PVE_LEVELS, pveState, pveConfig, pvePass,
  puzzleToday, puzzleState, puzzleClaim,
  claimSecret, verifySecret, resetSecret, secretInfo, unlockAchievements, allNicks, seatBadges, bumpDailyTournament, friendsOf, // v15/v22/v23/v24/v28/v30/v33
  verifyNickOwnership, // v16 昵称占用保护
  bumpDaily, // v33 每日任务进度（recordGame 内部已调用，导出便于测试）
  flush: save, // v33 优雅退出时强制落盘
};
