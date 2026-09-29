/**
 * test-v33.js — v33 修复项回归测试
 *
 * 覆盖本次 P0/P1 修复：
 *   1. accel 道具越界不再抛异常（精确到达模式 rp+4 > FINISH_RP）
 *   2. 团队赛 accel 不再误判单座位获胜
 *   3. 每日任务进度随对局推进（recordGame → daily.games/wins/kills）
 *   4. awardCoins/awardDiamonds 拒绝负数与非整数
 *   5. pushMailBatch 批量投信只落一次盘且内容正确
 *
 * 运行：node tests/test-v33.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// 必须在 require 之前指定隔离的数据目录，避免污染真实战绩
process.env.STATS_DIR = path.join(os.tmpdir(), 'flychess-v33-' + Date.now());
fs.mkdirSync(process.env.STATS_DIR, { recursive: true });

const { createGame, useItem } = require('../server/src/game-engine/game-controller');
const stats = require('../server/src/stats');
const meta = require('../server/src/meta');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✅ ' + name); } else { fail += 1; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')); }
}

console.log('\n[1] accel 越界不再抛异常');
{
  const seats = [{ type: 'human' }, { type: 'ai', aiLevel: 2 }, { type: 'ai', aiLevel: 2 }, { type: 'ai', aiLevel: 2 }];
  const g = createGame(seats, { needExactFinish: true, allowItems: true });
  g.phase = 'rolling';
  g.currentSeat = 0;
  g.items = [0, 1, 2, 3].map(() => ({ bomb: 0, shield: 0, accel: 1, swap: 0 }));
  g.players[0].planes[0].rp = 55; // 55 + 4 = 59 > 57
  g.players[0].planes[0].state = 'lane';
  let threw = null, res = null;
  try { res = useItem(g, 0, 'accel', { target: { seat: 0, planeId: 0 } }, Math.random); } catch (e) { threw = e.message; }
  ok('不抛 MOVE_EXCEEDS_HOME', threw === null, threw);
  ok('非法使用返回 ok:false', res && res.ok === false);
  ok('道具未被消耗', g.items[0].accel === 1);
}

console.log('\n[2] 团队赛 accel 不误判单座位获胜');
{
  const seats = [{ type: 'human' }, { type: 'ai', aiLevel: 2 }, { type: 'ai', aiLevel: 2 }, { type: 'ai', aiLevel: 2 }];
  const g = createGame(seats, { needExactFinish: true, allowItems: true, teamMode: true });
  g.phase = 'rolling';
  g.currentSeat = 0;
  g.items = [0, 1, 2, 3].map(() => ({ bomb: 0, shield: 0, accel: 1, swap: 0 }));
  g.players[0].planes.forEach((p, i) => { p.rp = i === 0 ? 53 : 57; p.state = i === 0 ? 'lane' : 'home'; });
  g.players[0].finishedCount = 3;
  useItem(g, 0, 'accel', { target: { seat: 0, planeId: 0 } }, Math.random);
  ok('座位 0 已 4 机到家但整局未结束', g.phase !== 'ended', 'phase=' + g.phase);
  ok('未错误设置 winnerTeam', g.winnerTeam === null, String(g.winnerTeam));
}

console.log('\n[3] 每日任务随对局推进');
{
  stats.recordGame([
    { nick: 'v33a', seat: 0, color: 'red', rank: 1, isWinner: true, kills: 2, beenKilled: 0, sixes: 3, finishedCount: 4 },
    { nick: 'v33b', seat: 1, color: 'yellow', rank: 2, isWinner: false, kills: 1, beenKilled: 1, sixes: 1, finishedCount: 2 },
  ], '933001', {});
  const da = stats.dailyState('v33a');
  const db = stats.dailyState('v33b');
  ok('胜者 daily.games=1', da.games === 1, JSON.stringify(da));
  ok('胜者 daily.wins=1', da.wins === 1);
  ok('胜者 daily.kills=2', da.kills === 2);
  ok('败者也计入 games', db.games === 1 && db.wins === 0);
  ok('「今日首战」标记完成', da.tasks.find((t) => t.id === 'play1').done === true);
  ok('「旗开得胜」标记完成', da.tasks.find((t) => t.id === 'win1').done === true);
  const claim = stats.claimDaily('v33a');
  ok('可领取每日奖励（不再 NO_TASK_DONE）', claim.ok === true, JSON.stringify(claim));
}

console.log('\n[4] 发币金额校验');
{
  const before = stats.playerStats('v33a').coins;
  ok('拒绝负数发币', stats.awardCoins('v33a', -50).ok === false);
  ok('拒绝非整数（NaN）', stats.awardCoins('v33a', 'abc').ok === false);
  const r = stats.awardCoins('v33a', 10);
  ok('正常发币成功', r.ok === true && r.coins === before + 10, JSON.stringify(r));
  ok('钻石同样拒绝负数', stats.awardDiamonds('v33a', -1).ok === false);
}

console.log('\n[5] 批量站内信');
{
  const n = meta.pushMailBatch([
    { nick: 'v33m1', entry: { kind: 'game', rank: 1 } },
    { nick: 'v33m1', entry: { kind: 'achievement', achs: [] } },
    { nick: 'v33m2', entry: { kind: 'game', rank: 2 } },
  ]);
  ok('批量投信返回 3', n === 3, String(n));
  ok('v33m1 收到 2 封', meta.listMail('v33m1').list.length === 2, String(meta.listMail('v33m1').list.length));
  ok('v33m2 收到 1 封', meta.listMail('v33m2').list.length === 1, String(meta.listMail('v33m2').list.length));
  ok('新信件在最前', meta.listMail('v33m1').list[0].kind === 'achievement');
  ok('v33m1 未读 2 封', meta.listMail('v33m1').unread === 2);
  ok('单封投信仍可用（pushMail）', meta.pushMail('v33m1', { kind: 'system', title: 'x' }) === true
    && meta.listMail('v33m1').list.length === 3);
}

console.log('\n[6] 凭证认领与追溯');
{
  const v = stats.verifySecret('v33c', 'abcd1234');
  ok('首次出示即认领', v.ok === true && v.claimed === true);
  ok('凭证认领时间可追溯', stats.secretInfo('v33c').secretSetAt > 0);
  ok('错误凭证被拒', stats.verifySecret('v33c', 'wrong-secret').error === 'AUTH_FAILED');
  ok('重置后可重新认领', stats.resetSecret('v33c') === true
    && stats.verifySecret('v33c', 'new-secret').claimed === true);
}

console.log('\n———————————————');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(process.env.STATS_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(fail ? 1 : 0);
