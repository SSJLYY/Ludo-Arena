/**
 * test-mail-ach.js — v19 成就解锁战报 + 对局战报 单元专项
 *
 * 不起服务器：直接以进程内 require 驱动 stats.recordGame（战报推送所在层），
 * 用精确构造的对局数据做确定性断言（kills=5 → ace；isWinner → first_win；
 * sixes=12 → six_king）。覆盖：
 *   1. 胜局生成 2 条战报：对局战报 + 成就解锁战报（字段与图标/名称映射正确）
 *   2. 未读计数与已读流转
 *   3. 无新成就的败局只生成 1 条对局战报
 *   4. AI/无昵称行不入箱
 *   5. PVE 关卡标记透传
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.error('  ✗ ' + label); }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychess-ach-'));
process.env.STATS_DIR = dataDir;

// ⚠️ 必须在设置 STATS_DIR 之后再 require（两个模块都在加载期读取该变量）
const stats = require(path.join(__dirname, '..', 'server', 'src', 'stats'));
const meta = require(path.join(__dirname, '..', 'server', 'src', 'meta'));

try {
  console.log('[1] 胜局：对局战报 + 成就战报');
  stats.recordGame(
    [{ nick: '邮差', seat: 0, color: 'red', rank: 1, finishedCount: 4, kills: 5, beenKilled: 0, sixes: 12, isWinner: true }],
    '110001',
    { aiLevels: [2], pveLevel: null },
  );
  let mail = meta.listMail('邮差');
  ok(mail.list.length === 2 && mail.unread === 2, '胜局生成 2 条未读战报（对局 + 成就）');
  const achMail = mail.list.find((m) => m.kind === 'achievement');
  ok(!!achMail, '存在成就解锁战报');
  const ids = achMail ? achMail.achs.map((a) => a.id) : [];
  ok(ids.includes('first_win') && ids.includes('ace') && ids.includes('six_king'),
    '成就映射正确（首胜/王牌杀手/六点狂魔）');
  ok(achMail.achs.every((a) => a.icon && a.name), '成就带图标与名称');
  const gameMail = mail.list.find((m) => m.kind === 'game');
  ok(gameMail && gameMail.isWinner === true && gameMail.rank === 1 && gameMail.roomNo === '110001',
    '对局战报字段正确');

  console.log('[2] 已读流转');
  meta.markMailRead('邮差');
  mail = meta.listMail('邮差');
  ok(mail.unread === 0 && mail.list.length === 2 && mail.list.every((m) => m.read), '标记已读后列表保留、未读归零');

  console.log('[3] 败局与隔离');
  stats.recordGame(
    [
      { nick: '邮差', seat: 0, color: 'red', rank: 2, finishedCount: 2, kills: 1, beenKilled: 3, sixes: 0, isWinner: false },
      { nick: '', seat: 1, color: 'yellow', rank: 1, finishedCount: 4, kills: 3, beenKilled: 1, sixes: 0, isWinner: true }, // AI 空昵称
    ],
    '110002',
    { aiLevels: [2], pveLevel: null },
  );
  mail = meta.listMail('邮差');
  ok(mail.list.length === 3 && mail.unread === 1, '败局只生成 1 条对局战报（无新成就），新在前');
  ok(mail.list[0].kind === 'game' && mail.list[0].isWinner === false, '最新一条是败局战报');
  ok(meta.listMail('电脑').list.length === 0, 'AI/空昵称不入箱');

  console.log('[4] PVE 标记');
  stats.recordGame(
    [{ nick: '闯王', seat: 0, color: 'red', rank: 1, finishedCount: 4, kills: 2, beenKilled: 1, sixes: 0, isWinner: true }],
    '110003',
    { aiLevels: [3], pveLevel: 6 },
  );
  const pm = meta.listMail('闯王').list;
  ok(pm.some((m) => m.kind === 'game' && m.pveLevel === 6 && m.isWinner === true), 'PVE 关卡标记透传（第 6 关胜）');

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
  console.log('========================================');
  process.exitCode = failed ? 1 : 0;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* tmp 清理失败无碍 */ }
}
