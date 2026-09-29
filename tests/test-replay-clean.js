/**
 * test-replay-clean.js — v20 回放孤儿文件清理 单元专项
 *
 * 进程内直调 replays 模块（STATS_DIR 指向临时目录），走真实裁剪路径：
 * 保存 51 局 → 索引裁到 50 → 最老一局成为孤儿 → cleanOrphanReplays 精确删除。
 * 覆盖：
 *   1. 索引 50 局上限裁剪（saveReplay 内 slice）
 *   2. 孤儿文件被精确清理（只删索引外的）
 *   3. 幂等：再跑不误删；索引文件与索引内文件完好
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.error('  ✗ ' + label); }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychess-rp-'));
process.env.STATS_DIR = dataDir;

// ⚠️ 必须在设置 STATS_DIR 之后再 require（模块在加载期读取该变量）
const replays = require(path.join(__dirname, '..', 'server', 'src', 'replays'));

const mkFrames = (n) => Array.from({ length: n }, (_, i) => ({ t: i, room: {}, game: { phase: 'rolling' } }));
const RP_DIR = path.join(dataDir, 'replays');
function files() {
  return fs.readdirSync(RP_DIR).filter((f) => f.endsWith('.json') && f !== 'replays-index.json');
}

try {
  console.log('[1] 保存 101 局触发索引裁剪（v33 上限 100）');
  for (let i = 1; i <= 101; i++) {
    const no = String(700000 + i);
    if (!replays.saveReplay(no, mkFrames(5), { winner: 0, endedAt: Date.now(), players: [] })) {
      throw new Error('saveReplay failed: ' + no);
    }
  }
  ok(replays.listReplays().length === 100, '索引裁到 100 局（最老的 700001 被裁掉）');
  ok(files().length === 101, '但磁盘上仍有 101 个文件（孤儿未清）');

  console.log('[2] 清理孤儿');
  const removed = replays.cleanOrphanReplays();
  ok(removed === 1 && !fs.existsSync(path.join(RP_DIR, '700001.json')), '孤儿 700001.json 被精确删除');
  ok(files().length === 100, '磁盘剩 100 个文件，与索引一致');
  ok(!!replays.getReplay('700002') && !!replays.getReplay('700002'.slice(0,0) + '700002'), '索引内最老一局（700002）完好可读');
  ok(!replays.getReplay('700001'), '被清理的回放读取返回 null');

  console.log('[3] 幂等与保护');
  ok(replays.cleanOrphanReplays() === 0, '再跑一遍幂等（不误删）');
  ok(fs.existsSync(path.join(RP_DIR, 'replays-index.json')), '索引文件不受影响');

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
  console.log('========================================');
  process.exitCode = failed ? 1 : 0;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* tmp 清理失败无碍 */ }
}
