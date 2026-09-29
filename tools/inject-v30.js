/* inject-v30.js — 社交闭环：好友上线提醒 + 结算页加好友/查战绩（执行后删除） */
const fs = require('fs');
const path = require('path');

// ============ 服务端 ============

// 1) stats.js：friendsOf 反查
const sfile = path.join(__dirname, '..', 'server', 'src', 'stats.js');
let s = fs.readFileSync(sfile, 'utf8');
if (!s.includes('function friendsOf')) {
  const anchor = `function friendListWithOnline(nick, onlineSet) {`;
  const add = `/** v30 反查好友：把 nick 加为好友的所有玩家（好友上线提醒用） */
function friendsOf(nick) {
  ensureFresh();
  const key = String(nick || '').trim().slice(0, 16);
  const out = [];
  for (const [owner, list] of Object.entries(data.friendships)) {
    if (Array.isArray(list) && list.includes(key) && owner !== key) out.push(owner);
  }
  return out;
}

` + anchor;
  if (!s.includes(anchor)) { console.error('FOF MISS'); process.exit(1); }
  s = s.replace(anchor, add);
  s = s.replace('  bumpDailyTournament, // v15/v22/v23/v24/v28', '  bumpDailyTournament, friendsOf, // v15/v22/v23/v24/v28/v30');
  fs.writeFileSync(sfile, s);
}

// 2) websocket.js：pushNotify + regOnline 新上线钩子
const wfile = path.join(__dirname, '..', 'server', 'src', 'websocket.js');
let w = fs.readFileSync(wfile, 'utf8');
if (!w.includes('function pushNotify')) {
  const anchor = `// 服务端权威随机源（防作弊）`;
  const add = `/** v30 通用好友通知推送（好友上线提醒） */
function pushNotify(toNick, data) {
  const set = onlineUsers.get(String(toNick || '').trim());
  if (!set) return false;
  let sent = false;
  for (const ws of set) {
    try { ws.send(JSON.stringify({ type: 'friend_online', data })); sent = true; } catch (e) { /* ignore */ }
  }
  return sent;
}

// 服务端权威随机源（防作弊）`;
  w = w.replace(anchor, add);
}
const oldReg = `function regOnline(nick, ws) {
  nick = String(nick || '').trim();
  if (!nick) return;
  if (!onlineUsers.has(nick)) onlineUsers.set(nick, new Set());
  onlineUsers.get(nick).add(ws);
}`;
const newReg = `function regOnline(nick, ws) {
  nick = String(nick || '').trim();
  if (!nick) return;
  const wasOnline = onlineUsers.has(nick) && onlineUsers.get(nick).size > 0;
  if (!onlineUsers.has(nick)) onlineUsers.set(nick, new Set());
  onlineUsers.get(nick).add(ws);
  // v30 好友上线提醒：从离线变为在线时，通知所有把 TA 加为好友的在线玩家
  if (!wasOnline) {
    try {
      for (const friend of stats.friendsOf(nick)) pushNotify(friend, { nick });
    } catch (e) { /* ignore */ }
  }
}`;
if (!w.includes(oldReg)) { console.error('REG MISS'); process.exit(1); }
w = w.replace(oldReg, newReg);
fs.writeFileSync(wfile, w);

// 3) 前端：notify 消息处理 + 结算页社交按钮
const afile = path.join(__dirname, '..', 'server', 'public', 'js', 'app.js');
let a = fs.readFileSync(afile, 'utf8');

// 3a) 好友上线 toast
if (!a.includes('friend_online')) {
  const anchor = `      if (msg.type === 'invite') showInvite(msg.data);`;
  const add = `      if (msg.type === 'invite') showInvite(msg.data);
      else if (msg.type === 'friend_online') toast('🟢 好友「' + escapeHtml((msg.data && msg.data.nick) || '') + '」上线了'); // v30`;
  if (!a.includes(anchor)) { console.error('NOTIFY MISS'); process.exit(1); }
  a = a.replace(anchor, add);
}

// 3b) 结算页：行内社交占位（非自己 human 座位）
const oldRow = `        <span class="w-six">🎲\${p.sixes || 0}</span>
      </div>\`).join('');`;
const newRow = `        <span class="w-six">🎲\${p.sixes || 0}</span>
        \${(!teamMode && p.seat !== state.seat && currentRoom && currentRoom.seats[p.seat] && currentRoom.seats[p.seat].type === 'human')
          ? '<span class="w-social" data-nick="' + escapeHtml(p.nick) + '"></span>' : ''}
      </div>\`).join('');`;
if (!a.includes(oldRow)) { console.error('ROW MISS'); process.exit(1); }
a = a.replace(oldRow, newRow);

// 3c) banner 渲染后异步填充社交按钮（挂在 banner append 之后执行）
if (!a.includes('v30 结算页社交闭环')) {
  const anchor = `    document.body.appendChild(b);`;
  const add = `    document.body.appendChild(b);
    // v30 结算页社交闭环：一键加好友 / 查战绩
    (async () => {
      if (!state.nick) return;
      let friends = [];
      try {
        const fl = await jget('/api/friend/list?nick=' + encodeURIComponent(state.nick));
        friends = (fl.friends || []).map((f) => f.nick);
      } catch (e) { /* ignore */ }
      b.querySelectorAll('.w-social').forEach((el) => {
        const n2 = el.dataset.nick;
        const isFriend = friends.includes(n2);
        el.innerHTML = (isFriend
          ? '<span class="w-friend-tag">✓ 好友</span>'
          : '<button class="w-friend-btn" data-nick="' + escapeHtml(n2) + '">+ 好友</button>')
          + '<button class="w-stat-btn" data-nick="' + escapeHtml(n2) + '">战绩</button>';
      });
      b.querySelectorAll('.w-friend-btn').forEach((btn) => {
        btn.onclick = async () => {
          try {
            const r = await jpost('/api/friend/add', { nick: state.nick, friend: btn.dataset.nick });
            if (r.ok) btn.outerHTML = '<span class="w-friend-tag">✓ 已加</span>';
            else toast('添加失败：' + (r.error || ''));
          } catch (e) { toast('添加失败'); }
        };
      });
      b.querySelectorAll('.w-stat-btn').forEach((btn) => {
        btn.onclick = () => {
          $('lbNick').value = btn.dataset.nick;
          $('modal-lb').classList.add('show');
          queryPlayerStats(btn.dataset.nick);
        };
      });
    })();`;
  if (!a.includes(anchor)) { console.error('APPEND MISS'); process.exit(1); }
  a = a.replace(anchor, add);
}
fs.writeFileSync(afile, a);

// 4) CSS
const pub = path.join(__dirname, '..', 'server', 'public');
let css = fs.readFileSync(path.join(pub, 'css', 'style.css'), 'utf8');
if (!css.includes('.w-friend-btn')) {
  css += `

/* ==================== v30 结算页社交闭环 ==================== */
.w-social { display: inline-flex; gap: 6px; margin-left: 8px; }
.w-friend-btn, .w-stat-btn {
  font: inherit; font-size: 12px; font-weight: 700; padding: 4px 10px;
  border-radius: 999px; cursor: pointer;
  background: rgba(106,92,255,.14); border: 1px solid rgba(106,92,255,.5); color: var(--brand, #6a5cff);
}
.w-friend-btn:hover, .w-stat-btn:hover { background: rgba(106,92,255,.25); }
.w-friend-tag { font-size: 12px; opacity: .7; }
`;
  fs.writeFileSync(path.join(pub, 'css', 'style.css'), css);
}
console.log('v30 injected');
