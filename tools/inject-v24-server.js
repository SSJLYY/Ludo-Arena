/* inject-v24-server.js — 荣誉徽标透出（执行后删除） */
const fs = require('fs');
const path = require('path');

// 1) stats.seatBadges
const sfile = path.join(__dirname, '..', 'server', 'src', 'stats.js');
let st = fs.readFileSync(sfile, 'utf8');
if (!st.includes('function seatBadges')) {
  const anchor = `/** v23 全体玩家昵称（全服邮件用） */`;
  const add = `/** v24 荣誉徽标（对局场景可视化）：锦标赛冠军 👑 / 赛季之王 🌟。无档案返回 null。 */
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

` + anchor;
  st = st.replace(anchor, add);
  st = st.replace('  claimSecret, verifySecret, resetSecret, unlockAchievements, allNicks, // v15 凭证 / v22 成就 / v23 全服邮件',
    '  claimSecret, verifySecret, resetSecret, unlockAchievements, allNicks, seatBadges, // v15 凭证 / v22 成就 / v23 邮件 / v24 徽标');
  fs.writeFileSync(sfile, st);
}

// 2) room-manager publicRoom seats 透出 badges
const rfile = path.join(__dirname, '..', 'server', 'src', 'room-manager.js');
let rm = fs.readFileSync(rfile, 'utf8');
if (!rm.includes('badges: stats.seatBadges')) {
  // 找 publicRoom 内 seats 的 map：含 color/type/nickName 字段
  const anchor = `      seats: room.seats.map((s) => ({`;
  if (!rm.includes(anchor)) { console.error('PUBLICROOM MISS'); process.exit(1); }
  // 在 map 的返回对象里补 badges 字段——先看对象结尾，用占位替换法：
  // 定位 anchor 后的第一个 `})),` 前（seats map 的对象字面量结束）不安全；
  // 改为在 seat 对象的 nickName 行后插入一行。查该行：
  const lines = rm.split('\n');
  const startIdx = lines.findIndex((l) => l.includes(anchor.trim().slice(0, 30)));
  let inserted = false;
  for (let i = startIdx; i < Math.min(startIdx + 14, lines.length); i++) {
    if (lines[i].includes('nickName:')) {
      lines.splice(i + 1, 0, "        badges: s.type === 'human' && s.nickName ? stats.seatBadges(s.nickName) : null, // v24 荣誉徽标");
      inserted = true;
      break;
    }
  }
  if (!inserted) { console.error('NICKLINE MISS'); process.exit(1); }
  rm = lines.join('\n');
  fs.writeFileSync(rfile, rm);
}
console.log('server badges ok');
