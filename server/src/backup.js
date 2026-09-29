/**
 * backup.js — v12 数据备份（P4 运维）
 *
 * 宿主约束回顾：CentOS 7 + overlayfs 下不能用 SQLite，数据都是 JSON 文件。
 * 所以备份就是「把 data 目录下的 json 复制一份带时间戳的副本」，零依赖、零外部命令。
 *
 * 备份落 ${STATS_DIR:-<server>/data}/backups/YYYY-MM-DD_HHmmss/
 * 保留最近 KEEP 份，超出自动清理最老的，避免撑爆 50G 盘。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.STATS_DIR || path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP = Number(process.env.BACKUP_KEEP || 14);
const FILES = ['stats.json', 'meta.json', 'rooms.json', 'announce.json'];

function stamp() {
  const d = new Date(Date.now() + 8 * 3600000); // 东八区
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** 执行一次备份，返回 { dir, files, bytes } */
function runBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = stamp();
  const dir = path.join(BACKUP_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const copied = [];
  let bytes = 0;
  FILES.forEach((f) => {
    const src = path.join(DATA_DIR, f);
    try {
      const buf = fs.readFileSync(src);
      fs.writeFileSync(path.join(dir, f), buf);
      copied.push(f);
      bytes += buf.length;
    } catch (e) { /* 文件不存在就跳过，不算失败 */ }
  });
  prune();
  return { dir: name, files: copied, bytes };
}

/** 只保留最近 KEEP 份 */
function prune() {
  try {
    const dirs = fs.readdirSync(BACKUP_DIR)
      .filter((d) => /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(d))
      .sort();
    while (dirs.length > KEEP) {
      const old = dirs.shift();
      const p = path.join(BACKUP_DIR, old);
      try {
        fs.readdirSync(p).forEach((f) => fs.unlinkSync(path.join(p, f)));
        fs.rmdirSync(p);
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((d) => /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(d))
      .sort().reverse()
      .map((d) => {
        let bytes = 0;
        let files = [];
        try {
          files = fs.readdirSync(path.join(BACKUP_DIR, d));
          files.forEach((f) => { bytes += fs.statSync(path.join(BACKUP_DIR, d, f)).size; });
        } catch (e) { /* ignore */ }
        return { name: d, files: files.length, bytes };
      });
  } catch (e) { return []; }
}

/** 每天 03:00(东八区) 自动备份一次；进程内定时器，容器重启后自动重排 */
function scheduleDaily() {
  let lastDay = '';
  const tick = () => {
    const d = new Date(Date.now() + 8 * 3600000);
    const day = d.toISOString().slice(0, 10);
    // 10 分钟窗口 + 每天只跑一次的守卫（否则 03:00 与 03:09 两次 tick 会各备一份）
    if (d.getUTCHours() === 3 && d.getUTCMinutes() < 10 && lastDay !== day) {
      lastDay = day;
      try {
        const r = runBackup();
        console.log(`[backup] 自动备份完成 ${r.dir} (${r.files.length} 个文件 / ${r.bytes} 字节)`);
      } catch (e) { console.error('[backup] 失败:', e.message); }
    }
  };
  setInterval(tick, 10 * 60 * 1000).unref?.();
  return true;
}

module.exports = { runBackup, listBackups, scheduleDaily, BACKUP_DIR };
