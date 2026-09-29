/**
 * verify-backup.js — v29 备份可恢复性验证
 *
 * 用法：
 *   本地最新备份：        node tests/verify-backup.js
 *   指定备份目录：        node tests/verify-backup.js /path/to/backups/2026-09-06_030251
 *   服务器最新备份：      SSH 到服务器后执行同命令（deploy 流程可加）
 *
 * 校验：每个备份文件可 JSON.parse；关键字段结构完整（players/games/guilds/mail/champList/房间）。
 * 输出逐文件结论 + 总体可恢复性判定。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.STATS_DIR || path.join(__dirname, '..', 'server', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function latestBackupDir(base) {
  const dirs = fs.readdirSync(base).filter((d) => /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(d)).sort();
  if (!dirs.length) throw new Error('没有找到备份目录');
  return path.join(base, dirs[dirs.length - 1]);
}

function checkJson(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, raw };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function main() {
  const target = process.argv[2] || latestBackupDir(BACKUP_DIR);
  console.log('[verify] 备份目录:', target);
  let pass = 0, fail = 0;
  const check = (cond, label) => {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.error('  ✗ ' + label); }
  };

  // stats.json
  if (fs.existsSync(path.join(target, 'stats.json'))) {
    const st = checkJson(path.join(target, 'stats.json'));
    check(st.ok, 'stats.json 可解析');
    if (st.ok) {
      check(st.raw.players && typeof st.raw.players === 'object', 'stats.players 结构完整（' + Object.keys(st.raw.players || {}).length + ' 名玩家）');
      check(Array.isArray(st.raw.games), 'stats.games 结构完整（' + (st.raw.games || []).length + ' 局）');
    }
  } else { fail++; console.error('  ✗ stats.json 缺失'); }

  // meta.json
  if (fs.existsSync(path.join(target, 'meta.json'))) {
    const mt = checkJson(path.join(target, 'meta.json'));
    check(mt.ok, 'meta.json 可解析');
    if (mt.ok) {
      check(mt.raw.guilds && typeof mt.raw.guilds === 'object', 'meta.guilds 结构完整（' + Object.keys(mt.raw.guilds || {}).length + ' 个公会）');
      check(mt.raw.mail === undefined || typeof mt.raw.mail === 'object', 'meta.mail 结构完整');
      check(mt.raw.champList === undefined || Array.isArray(mt.raw.champList), 'meta.champList 结构完整');
    }
  } else { fail++; console.error('  ✗ meta.json 缺失'); }

  // rooms.json
  if (fs.existsSync(path.join(target, 'rooms.json'))) {
    const rm = checkJson(path.join(target, 'rooms.json'));
    check(rm.ok, 'rooms.json 可解析');
  }

  console.log('\n========================================');
  console.log(fail === 0 ? '✅ 备份可恢复性验证通过（' + pass + ' 项）' : '✗ 验证失败 ' + fail + ' 项');
  console.log('========================================');
  process.exitCode = fail ? 1 : 0;
}

main();
