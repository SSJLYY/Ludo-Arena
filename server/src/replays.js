/**
 * replays.js — 对局回放持久化（JSON 文件，零依赖）
 *
 * 与 stats.js 同源约束：本宿主（CentOS 7 / 内核 3.10 + overlayfs）上 SQLite 等依赖
 * 文件锁的存储全不可用，一律 JSON 原子写（写 tmp → rename）。
 *
 * 存储：
 *   ${STATS_DIR}/replays/<roomNo>.json   单局回放（逐帧 state 快照，cap MAX_FRAMES）
 *   ${STATS_DIR}/replays-index.json      轻量索引（roomNo/endedAt/winner/count），供列表查询
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib'); // v34 回放文件 gzip 落盘（省约 70% 磁盘）

const DATA_DIR = process.env.STATS_DIR || path.join(__dirname, '..', 'data');
const REPLAY_DIR = path.join(DATA_DIR, 'replays');
const INDEX_FILE = path.join(REPLAY_DIR, 'replays-index.json');
const MAX_FRAMES = 1500; // 单局最多保留帧数，超出截断头部
const MAX_INDEX = Number(process.env.REPLAY_KEEP) || 100;   // v33 提到 100 局（战报回放直达的过期窗口翻倍）

try { fs.mkdirSync(REPLAY_DIR, { recursive: true }); } catch (e) { /* ignore */ }

let indexData = loadIndex();

function loadIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

function saveIndex() {
  try {
    fs.writeFileSync(INDEX_FILE + '.tmp', JSON.stringify(indexData));
    fs.renameSync(INDEX_FILE + '.tmp', INDEX_FILE);
  } catch (e) {
    try { fs.writeFileSync(INDEX_FILE, JSON.stringify(indexData)); } catch (e2) { /* ignore */ }
  }
}

function replayFile(roomNo) {
  return path.join(REPLAY_DIR, String(roomNo).replace(/[^0-9]/g, '') + '.json');
}

/**
 * 保存一局回放。frames: [{ t, room, game }]（与 WS 广播的 state.data 同构）。
 * meta: { winner, seats:[{nick,color}], endedAt }
 */
function saveReplay(roomNo, frames, meta) {
  try {
    const list = Array.isArray(frames) ? frames.slice(-MAX_FRAMES) : [];
    if (!list.length) return false;
    const payload = {
      roomNo: String(roomNo),
      endedAt: (meta && meta.endedAt) || list[list.length - 1].t,
      winner: meta && typeof meta.winner === 'number' ? meta.winner : null,
      count: list.length,
      frames: list,
    };
    const f = replayFile(roomNo);
    fs.writeFileSync(f + '.tmp', zlib.gzipSync(Buffer.from(JSON.stringify(payload)))); // v34 gzip
    fs.renameSync(f + '.tmp', f);

    indexData = indexData.filter((r) => r.roomNo !== String(roomNo));
    indexData.unshift({
      roomNo: String(roomNo),
      endedAt: payload.endedAt,
      winner: payload.winner,
      count: payload.count,
      players: (meta && meta.players) || [],
    });
    if (indexData.length > MAX_INDEX) indexData = indexData.slice(0, MAX_INDEX);
    saveIndex();
    return true;
  } catch (e) {
    console.error('[replays] save failed:', e.message);
    return false;
  }
}

/** 回放列表（最近在前） */
function listReplays() {
  return indexData.slice();
}

/** 单局回放（含 frames），不存在返回 null */
function getReplay(roomNo) {
  try {
    const buf = fs.readFileSync(replayFile(roomNo));
    try {
      return JSON.parse(zlib.gunzipSync(buf).toString('utf8')); // v34 gzip 格式
    } catch (e) {
      return JSON.parse(buf.toString('utf8')); // v34 前的旧纯 JSON 兼容
    }
  } catch (e) {
    return null;
  }
}

/**
 * v20 存储卫生：删除索引之外的孤儿回放文件。
 * 索引只保留最近 MAX_INDEX(50) 局，被裁掉的 *.json 若不清理会永久占盘
 * （实测单局约 1-2MB）。启动时 + 每天调用一次。返回删除的文件数。
 */
function cleanOrphanReplays() {
  let removed = 0;
  try {
    const keep = new Set(indexData.map((r) => String(r.roomNo)));
    for (const f of fs.readdirSync(REPLAY_DIR)) {
      if (f === 'replays-index.json' || !f.endsWith('.json')) continue;
      const roomNo = f.replace(/\.json$/, '');
      if (keep.has(roomNo)) continue;
      try { fs.unlinkSync(path.join(REPLAY_DIR, f)); removed += 1; } catch (e) { /* 单个失败不影响其余 */ }
    }
  } catch (e) {
    console.error('[replays] clean failed:', e.message);
  }
  if (removed) console.log(`[replays] 已清理 ${removed} 个孤儿回放文件`);
  return removed;
}

module.exports = { saveReplay, listReplays, getReplay, cleanOrphanReplays };
