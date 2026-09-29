/**
 * test-season.js — v17 多维榜单 + 名人堂 + 自动赛季结算 专项测试
 *
 * 自起独立服务实例（临时数据目录），预置上月赛季对局数据。覆盖：
 *   1. 启动即自动结算上月赛季：前三发币 + 名人堂归档 + 审计留痕
 *   2. 重启幂等：游标 + DUP 保护，不重复发奖、不重复归档
 *   3. /api/stats/boards 四榜返回且排序正确（击杀榜降序、签到榜只含有签到的）
 *   4. /api/stats/hall 返回归档赛季
 *   5. 手动结算：DUP → ALREADY_SETTLED；空赛季 → EMPTY；BAD_TOKEN 鉴权
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3460;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN_TOKEN = 'test-token';
const SERVER_DIR = path.join(__dirname, '..', 'server');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.error('  ✗ ' + label); }
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve(JSON.parse(buf || '{}')));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 当前自然月（东八区，与 stats.currentSeason 同口径） */
function curSeason() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
}
function prevSeason(season) {
  const [y, m] = String(season).split('-').map(Number);
  const pm = m - 1;
  return pm >= 1 ? `${y}-${String(pm).padStart(2, '0')}` : `${y - 1}-12`;
}

function startServer(dataDir) {
  return spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_DIR,
    env: Object.assign({}, process.env, { PORT: String(PORT), STATS_DIR: dataDir, ADMIN_TOKEN }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitUp() {
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { if ((await req('GET', '/health')).ok) return true; } catch (e) { /* not yet */ }
  }
  return false;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychess-season-'));
  // 预置上月赛季对局：甲 2 胜 / 乙 1 胜（击杀最多）/ 丙 0 胜，供自动结算与榜单断言
  const prev = prevSeason(curSeason());
  const mkGame = (id, results) => ({ id, endedAt: Date.now() - 40 * 86400000, season: prev, roomNo: 'T' + id, results });
  const mkRow = (nick, color, kills, isWinner) => ({
    nick, seat: 0, color, rank: isWinner ? 1 : 2, finishedCount: isWinner ? 4 : 2,
    kills, beenKilled: 1, sixes: 0, isWinner,
  });
  const players = {
    '甲': { nick: '甲', games: 3, wins: 2, kills: 4, beenKilled: 1, lastPlay: Date.now() - 40 * 86400000, streak: 0, bestStreak: 2, sixes: 0, bestKills: 2, achievements: [], coins: 0, signDate: '', signStreak: 0, skins: ['classic'], equipped: 'classic', props: [] },
    '乙': { nick: '乙', games: 3, wins: 1, kills: 9, beenKilled: 2, lastPlay: Date.now() - 40 * 86400000, streak: 0, bestStreak: 1, sixes: 0, bestKills: 4, achievements: [], coins: 0, signDate: '', signStreak: 6, skins: ['classic'], equipped: 'classic', props: [] },
    '丙': { nick: '丙', games: 3, wins: 0, kills: 2, beenKilled: 5, lastPlay: Date.now() - 40 * 86400000, streak: 0, bestStreak: 0, sixes: 0, bestKills: 1, achievements: [], coins: 0, signDate: '', signStreak: 0, skins: ['classic'], equipped: 'classic', props: [] },
  };
  fs.writeFileSync(path.join(dataDir, 'stats.json'), JSON.stringify({
    players,
    games: [
      mkGame(1, [mkRow('甲', 'red', 2, true), mkRow('乙', 'yellow', 4, false), mkRow('丙', 'blue', 1, false)]),
      mkGame(2, [mkRow('甲', 'red', 1, true), mkRow('乙', 'yellow', 3, false), mkRow('丙', 'blue', 1, false)]),
      mkGame(3, [mkRow('乙', 'yellow', 2, true), mkRow('甲', 'red', 1, false), mkRow('丙', 'blue', 0, false)]),
    ],
    friendships: {},
  }));

  console.log('[1] 启动自动结算');
  let child = startServer(dataDir);
  child.stderr.on('data', (c) => process.stderr.write('[server] ' + c));
  try {
    ok(await waitUp(), '服务实例启动');
    const hall = await req('GET', '/api/stats/hall');
    ok(hall.ok === true && hall.hall.length === 1 && hall.hall[0].season === prev,
      `启动即归档上月 ${prev} 赛季到名人堂`);
    const champs = (hall.hall[0] && hall.hall[0].champions) || [];
    ok(champs.length === 3 && champs[0].nick === '甲' && champs[0].bonus === 50 && champs[1].nick === '乙' && champs[2].nick === '丙',
      '前三名次与奖励正确（甲+50 / 乙+30 / 丙+20）');
    const pjia = await req('GET', '/api/stats/player?nick=' + encodeURIComponent('甲'));
    ok(pjia.player && pjia.player.coins === 50, '冠军金币已发放（' + (pjia.player ? pjia.player.coins : '?') + '）');
    const pkyi = await req('GET', '/api/stats/player?nick=' + encodeURIComponent('乙'));
    ok(pkyi.player && pkyi.player.coins === 30, '亚军金币已发放');

    console.log('[2] 重启幂等');
    child.kill();
    await sleep(500);
    child = startServer(dataDir);
    ok(await waitUp(), '服务重启');
    const hall2 = await req('GET', '/api/stats/hall');
    ok(hall2.hall.length === 1, '重启后名人堂不重复归档（仍 1 条）');
    const pjia2 = await req('GET', '/api/stats/player?nick=' + encodeURIComponent('甲'));
    ok(pjia2.player.coins === 50, '重启后不重复发奖（甲仍 50）');

    console.log('[3] 多维榜单');
    const boards = await req('GET', '/api/stats/boards?n=10');
    ok(boards.ok === true && boards.boards && boards.boards.winRate && boards.boards.kills && boards.boards.streak && boards.boards.sign,
      '四榜齐全（winRate/kills/streak/sign）');
    const k = boards.boards.kills;
    ok(k.length === 3 && k[0].nick === '乙' && k[0].kills === 9, '击杀榜首是乙（9 击落），降序正确');
    const s = boards.boards.sign;
    ok(s.length === 1 && s[0].nick === '乙' && s[0].signStreak === 6, '签到榜只含有签到记录的玩家（乙 6 天）');
    const wr = boards.boards.winRate;
    ok(wr[0].nick === '甲', '胜率榜首是甲（2/3）');

    console.log('[3.5] 赛季荣誉战报（v20）');
    const smail = await req('GET', '/api/mail?nick=' + encodeURIComponent('甲'));
    const seasonMail = (smail.list || []).find((m) => m.kind === 'season');
    ok(!!seasonMail && seasonMail.rank === 1 && seasonMail.bonus === 50 && seasonMail.season === prev,
      '冠军收到赛季荣誉战报（第 1 名 +50）');
    const smail2 = await req('GET', '/api/mail?nick=' + encodeURIComponent('丙'));
    const seasonMail2 = (smail2.list || []).find((m) => m.kind === 'season');
    ok(!!seasonMail2 && seasonMail2.rank === 3 && seasonMail2.bonus === 20, '季军也收到（第 3 名 +20）');
    const smailOut = await req('GET', '/api/mail?nick=' + encodeURIComponent('查无此人'));
    ok((smailOut.list || []).filter((m) => m.kind === 'season').length === 0, '未上榜玩家没有赛季战报');
    const pjiaAch = await req('GET', '/api/stats/player?nick=' + encodeURIComponent('甲'));
    ok(((pjiaAch.player || {}).achievements || []).includes('season_champ'), '赛季第一解锁「赛季之王」成就（v22）');

    console.log('[4] 手动结算');
    const dup = await req('POST', '/api/admin/season-settle', { token: ADMIN_TOKEN });
    ok(dup.ok === false && dup.error === 'ALREADY_SETTLED', '重复结算上月 → ALREADY_SETTLED');
    const empty = await req('POST', '/api/admin/season-settle', { token: ADMIN_TOKEN, season: '2020-01' });
    ok(empty.ok === false && empty.error === 'EMPTY', '空赛季结算 → EMPTY');
    const bad = await req('POST', '/api/admin/season-settle', { token: 'wrong' });
    ok(bad.ok === false && bad.error === 'BAD_TOKEN', '手动结算 token 鉴权');
    const au = await req('GET', '/api/admin/audit?token=' + ADMIN_TOKEN + '&n=50');
    ok((au.list || []).some((x) => x.kind === 'season_settle'), '审计含 season_settle 留痕');

    console.log('\n========================================');
    console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
    console.log('========================================');
    process.exitCode = failed ? 1 : 0;
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* tmp 清理失败无碍 */ }
  }
}

main().catch((e) => { console.error('SEASON TEST FAILED:', e); process.exit(1); });
