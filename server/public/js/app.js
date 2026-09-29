/* app.js — 飞行棋前端主逻辑
 *
 * 增强：座位视角旋转（自己左下）/ 音效+震动 / 事件特效（起飞/撞子/到家）
 *      / 对局结束完整排名 / 战绩榜 / 分享海报
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const VIEWS = ['lobby', 'room', 'game'];
  function switchView(name) {
    VIEWS.forEach((v) => $(`view-${v}`).classList.toggle('active', v === name));
    stopIdleLoop(); // 切视图就停掉选机动画循环（函数声明会提升，此处调用安全）
    if (name === 'lobby') { setTimeout(refreshHalls, 0); setTimeout(renderTodoCard, 0); } // 回到大厅顺手刷新房间/回放/待办
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), 2400);
  }
  function setConn(on) { $('connDot').className = 'dot ' + (on ? 'on' : 'off'); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // v24 荣誉徽标：👑 锦标赛冠军 / 🌟 赛季之王（publicRoom seats.badges）
  function badgeHtml(b) {
    if (!b) return '';
    return (b.tournamentChamp ? '<span class="h-badge" title="' + I18N.T('全服锦标赛冠军') + '">👑</span>' : '')
      + (b.seasonKing ? '<span class="h-badge" title="' + I18N.T('月度赛季榜第一') + '">🌟</span>' : '');
  }

  // ---- 持久化 ----
  const LS_KEY = 'fly_state_v1';
  function loadState() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; } }
  function saveState() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
  let state = loadState();
  if (!state.clientId) state.clientId = 'c' + Math.random().toString(36).slice(2, 10);
  // v15 账号凭证：本机随机生成、只存本地；服务端在首次建房/加入时认领，
  // 之后转账/签到/商城等财富操作必须出示，防止冒名盗刷（换设备可在设置里复制带走）。
  if (!state.secret) {
    const buf = new Uint8Array(16);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(buf) : buf.forEach((_, i) => { buf[i] = Math.floor(Math.random() * 256); });
    state.secret = Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
    saveState();
  }
  if (window.FlyAPI && FlyAPI.setToken) FlyAPI.setToken(state.secret); // api.js 先于 app.js 加载
  if (state.sfxOn === undefined) state.sfxOn = false;
  if (state.vibOn === undefined) state.vibOn = true;
  if (state.bgmOn === undefined) state.bgmOn = true;
  if (state.animMs === undefined) state.animMs = 380;
  if (state.theme === undefined) state.theme = 'classic';
  Sfx.setEnabled(state.sfxOn);
  Sfx.setBgm(state.bgmOn);
  Sfx.setVibration(state.vibOn);
  let ANIM_MS = state.animMs;

  let ws = null, currentRoom = null, currentGame = null;
  let notifyWs = null; // v9 常驻好友通知 WS
  let hitboxes = [];
  let planeShown = {};
  let prevSnap = {};
  let prevItems = null; // 上一次服务器状态里每人持卡数（用于检测获得道具特效）
  let usingItem = null; // v3 道具选目标模式：{ item, first:null|{seat,planeId} }
  let replayMode = false; // v2.0 回放中
  let replay = { frames: [], idx: 0, playing: true, speed: 1, timer: null };
  let animRAF = null, fxRAF = null, activeFx = null;
  // 低端机降级：核数少或安卓低内存设备放宽空闲重绘节流，降低发热与卡顿
  const LOW_END = (typeof navigator !== 'undefined' && (navigator.hardwareConcurrency || 8) <= 4)
    || (typeof navigator !== 'undefined' && /Android/.test(navigator.userAgent || '') && (navigator.deviceMemory || 8) <= 4);
  const IDLE_THROTTLE = LOW_END ? 48 : 32;
  let prev = { currentSeat: -1, phase: 'rolling', dice: 0 };
  let diceTimer = null, diceRolling = false, diceMinUntil = 0;
  let lastGameover = null; // 供海报用

  // 首次手势解锁音频
  const unlock = () => { Sfx.init(); document.removeEventListener('touchstart', unlock); document.removeEventListener('click', unlock); };
  document.addEventListener('touchstart', unlock, { passive: true });
  document.addEventListener('click', unlock);

  // ================= 大厅 =================
  // 三个入口卡：点击展开对应表单（手风琴），避免一上来堆满输入框
  function showPanel(which) {
    const isCreate = which === 'create';
    $('cardCreate').hidden = which !== 'create';
    $('cardJoin').hidden = which !== 'join';
    if (!which) return; // null = 两个都收起
    const el = isCreate ? $('cardCreate') : $('cardJoin');
    if (el && !el.hidden) {
      setTimeout(() => {
        try { el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { /* noop */ }
        (isCreate ? $('createNick') : $('joinNo')).focus();
      }, 60);
    }
  }
  $('btnCreate').onclick = () => showPanel($('cardCreate').hidden ? 'create' : null);
  $('btnJoin').onclick = () => showPanel($('cardJoin').hidden ? 'join' : null);
  showPanel(null);

  // ================= v7 在线房间大厅 =================
  const AI_LABEL = { 1: I18N.T('简单'), 2: I18N.T('普通'), 3: I18N.T('困难') };

  async function loadRoomHall() {
    const box = $('roomHall');
    if (!box) return;
    try {
      const res = await FlyAPI.listRooms();
      renderRoomHall(res.list || []);
    } catch (e) {
      box.innerHTML = '<div class="rh-empty">' + I18N.T('加载失败，点右上角重试') + '</div>';
    }
  }
  function renderRoomHall(list) {
    const box = $('roomHall');
    if (!list.length) { box.innerHTML = '<div class="rh-empty">' + I18N.T('暂时没有公开房间，创建一个吧！') + '</div>'; return; }
    box.innerHTML = list.map((r) => `
      <div class="rh-row">
        <div class="rh-main">
          <span class="rh-no">${escapeHtml(r.roomNo)}</span>
          <span class="rh-host">${escapeHtml(r.hostNick)}</span>
        </div>
        <div class="rh-meta">
          <span>👥 ${r.taken}/4</span>
          <span>🤖 ${AI_LABEL[r.aiLevel] || '普通'}</span>
          ${Number(r.diceMode) > 1 ? `<span class="rh-mode">${MODE_LABEL[Number(r.diceMode)] || I18N.T('🎲🎲 多骰')}</span>` : ''}
          ${r.spectators ? `<span>👁 ${r.spectators}</span>` : ''}
        </div>
        <button class="rh-btn" data-no="${escapeHtml(r.roomNo)}">${r.empties > 0 ? I18N.T('加入') : I18N.T('观战')}</button>
      </div>`).join('');
    box.querySelectorAll('.rh-btn').forEach((b) => { b.onclick = () => joinHallRoom(b.dataset.no); });
  }
  async function joinHallRoom(no) {
    const nick = ($('joinNick').value || state.nick || '').trim() || I18N.T('玩家');
    try {
      const res = await FlyAPI.joinRoom(no, { password: '', clientId: state.clientId, nickName: nick });
      state.nick = nick; state.roomNo = no; state.seat = res.seat; state.spectator = !!res.spectator; saveState();
      const r = await FlyAPI.getRoom(no);
      currentRoom = r.room;
      if (res.spectator && r.room.status === 'playing') {
        switchView('game'); planeShown = {}; prevSnap = {};
      } else {
        switchView('room');
      }
      renderRoom(r.room); connectWS();
      toast(res.spectator ? I18N.T('座位已满，已进入观战') : I18N.T('已加入房间 ') + no);
    } catch (e) { toast(I18N.T('加入失败：') + apiErrMsg(e)); loadRoomHall(); }
  }
  $('btnHallRefresh').onclick = loadRoomHall;

  // ================= v7 历史回放大厅 =================
  async function loadReplayHall() {
    const box = $('replayHall');
    if (!box) return;
    try {
      const res = await FlyAPI.listReplays();
      const list = (res.list || []).slice(0, 8);
      if (!list.length) { box.innerHTML = '<div class="rh-empty">还没有对局录像，打完一局就有了</div>'; return; }
      box.innerHTML = list.map((r) => {
        const names = (r.players || []).map((p) => p.nick).filter(Boolean).slice(0, 2).join(' vs ');
        return `<div class="rh-row rp-row">
          <div class="rh-main">
            <span class="rh-no">${escapeHtml(r.roomNo)}</span>
            <span class="rh-host">${escapeHtml(names || I18N.T('精彩对局'))}</span>
          </div>
          <div class="rh-meta">
            <span>🎬 ${r.count} 帧</span>
            <span>${r.endedAt ? fmtTime(r.endedAt) : ''}</span>
          </div>
          <button class="rh-btn" data-no="${escapeHtml(r.roomNo)}">${I18N.T('观看')}</button>
        </div>`;
      }).join('');
      box.querySelectorAll('.rh-btn').forEach((b) => { b.onclick = () => openReplay(b.dataset.no); });
    } catch (e) {
      box.innerHTML = '<div class="rh-empty">' + I18N.T('加载失败，点右上角重试') + '</div>';
    }
  }
  $('btnReplaysRefresh').onclick = loadReplayHall;

  // 大厅数据初始化 + 轮询刷新（只在大厅视图激活时才请求，省流量）
  function refreshHalls() {
    if (!$('view-lobby').classList.contains('active')) return;
    loadRoomHall();
    loadReplayHall();
    loadBanners();
    checkVersionHttp(); // v40 大厅没有心跳 pong，轮询时顺带做版本漂移检测
  }
  let _verChecking = false;
  function checkVersionHttp() {
    if (_verChecking) return;
    _verChecking = true;
    fetch('/health', { cache: 'no-store' }).then((r) => r.json()).then((h) => {
      if (h && h.version) checkVersionMatch(h.version);
    }).catch(() => {}).finally(() => { _verChecking = false; });
  }

  // v10 对局模式：1 经典单骰 / 2 双骰狂野 / 3 三骰狂欢
  const MODE_LABEL = { 1: I18N.T('🎲 经典单骰'), 2: I18N.T('🎲🎲 双骰狂野'), 3: I18N.T('🎲🎲🎲 三骰狂欢') };
  const MODE_TIP = {
    1: I18N.T('掷出 6 点可再掷一次，连掷 3 次 6 本回合作废。'),
    2: I18N.T('一次掷 2 颗，逐颗走完（可分给不同飞机）。6 点不再奖励再掷，击落敌机才奖励再掷一组。'),
    3: I18N.T('一次掷 3 颗，逐颗走完（可分给不同飞机）。6 点不再奖励再掷，击落敌机才奖励再掷一组。'),
  };

  // v3 道具元数据（与后端 ITEM_TYPES / 棋盘礼物格保持一致）
  const ITEM_META = {
    bomb:   { icon: '💣', name: I18N.T('炸弹'), hint: I18N.T('点选敌方一架在跑道上的飞机，炸回基地（安全格免疫）') },
    shield: { icon: '🛡️', name: I18N.T('护盾'), hint: I18N.T('立即为你的所有在途飞机挂上护盾，被撞时抵消') },
    accel:  { icon: '⚡', name: I18N.T('加速'), hint: I18N.T('点选自己一架在途飞机，免费前进 4 格') },
    swap:   { icon: '🔄', name: I18N.T('换位'), hint: I18N.T('依次点选两架在跑道上的飞机，交换它们的位置') },
  };
  const ITEM_ORDER = ['bomb', 'shield', 'accel', 'swap'];
  function currentMode() {
    const n = Number($('createMode') ? $('createMode').value : 1);
    return n === 2 || n === 3 ? n : 1;
  }
  function syncModeTip() {
    const tip = $('modeTip');
    if (tip) tip.textContent = MODE_TIP[currentMode()];
  }

  async function createAndEnter() {
    const nick = ($('createNick').value || I18N.T('房主')).trim();
    const password = $('createPwd').value;
    const aiLevel = Number($('createLevel').value);
    const diceMode = currentMode();
    const seriesRounds = Number($('createSeries') ? $('createSeries').value : 1) || 1;
    const res = await FlyAPI.createRoom({ password, settings: Object.assign({ aiLevel, diceMode, seriesRounds }, readRules()), nickName: nick });
    state.clientId = res.hostClientId; state.nick = nick; state.roomNo = res.roomNo; state.seat = 0; saveState();
    currentRoom = res.room;
    switchView('room'); renderRoom(res.room); connectWS();
    connectNotify();
    return res;
  }
  async function doCreate() {
    try {
      const res = await createAndEnter();
      toast(I18N.T('房间已创建：') + res.roomNo);
    } catch (e) { toast(I18N.T('创建失败：') + apiErrMsg(e)); }
  }

  async function doJoin() {
    const roomNo = $('joinNo').value.trim();
    const nick = ($('joinNick').value || I18N.T('玩家')).trim();
    const password = $('joinPwd').value;
    if (!roomNo) { toast('请输入房间号'); return; }
    try {
      const res = await FlyAPI.joinRoom(roomNo, { password, clientId: state.clientId, nickName: nick });
      state.nick = nick; state.roomNo = roomNo; state.seat = res.seat;
      state.spectator = !!res.spectator; saveState();
      connectNotify();
      const r = await FlyAPI.getRoom(roomNo);
      currentRoom = r.room;
      if (res.spectator) {
        if (r.room.status === 'playing') { switchView('game'); planeShown = {}; prevSnap = {}; }
        else switchView('room');
        renderRoom(r.room); connectWS();
        toast(I18N.T('座位已满，已进入观战'));
      } else {
        switchView('room'); renderRoom(r.room); connectWS();
        toast(I18N.T('已加入房间'));
      }
    } catch (e) { toast('加入失败：' + apiErrMsg(e)); }
  }
  $('btnCreateGo').onclick = doCreate;
  $('btnJoinGo').onclick = doJoin;
  // v10 切换对局模式时同步说明文案
  if ($('createMode')) {
    $('createMode').onchange = syncModeTip;
    syncModeTip();
  }
  // v7 #16 自定义规则开关：开关交互 + 读取当前规则
  document.querySelectorAll('.rules-toggles .switch').forEach((sw) => {
    sw.addEventListener('click', () => sw.classList.toggle('on'));
  });
  function readRules() {
    const r = {};
    document.querySelectorAll('.rules-toggles .switch').forEach((sw) => {
      r[sw.dataset.rule] = sw.classList.contains('on');
    });
    // v13 下拉型规则（turnSeconds / roundLimit 等）统一按数字读取
    document.querySelectorAll('.rules-toggles .rt-sel[data-rule]').forEach((sel) => {
      r[sel.dataset.rule] = Number(sel.value);
    });
    if (r.turnSeconds === undefined) r.turnSeconds = 30;
    return r;
  }
  $('joinNo').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  $('createNick').addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
  $('joinNick').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

  // 快速开始：建房 → 3 席设为电脑 → 直接开局
  $('btnQuick').onclick = async () => {
    const nick = ($('createNick').value || I18N.T('房主')).trim();
    const aiLevel = Number($('createLevel').value);
    const diceMode = currentMode();
    const btn = $('btnQuick');
    btn.disabled = true;
    try {
      const res = await FlyAPI.createRoom({ password: '', settings: Object.assign({ aiLevel, diceMode, seriesRounds: Number($('createSeries') ? $('createSeries').value : 1) || 1 }, readRules()), nickName: nick });
      state.clientId = res.hostClientId; state.nick = nick; state.roomNo = res.roomNo; state.seat = 0; saveState();
      for (let s = 1; s <= 3; s++) {
        await FlyAPI.setSeat(res.roomNo, { seat: s, action: 'set_ai', aiLevel, requesterSeat: 0 });
      }
      await FlyAPI.startGame(res.roomNo, 0);
      currentRoom = (await FlyAPI.getRoom(res.roomNo)).room;
      switchView('room'); renderRoom(currentRoom); connectWS();
      toast(I18N.T('已开局：你 vs 3 台电脑'));
    } catch (e) {
      toast(I18N.T('快速开始失败：') + apiErrMsg(e));
    } finally {
      btn.disabled = false;
    }
  };

  // v2.0 观战模式：主动观战某个房间（座位满或想看都行）
  window.joinAsSpectator = async (roomNo, nick) => {
    try {
      const res = await FlyAPI.joinRoom(roomNo, { password: '', clientId: state.clientId, nickName: nick || I18N.T('观战者'), watch: true });
      state.nick = nick || I18N.T('观战者'); state.roomNo = roomNo; state.seat = -1; state.spectator = true; saveState();
      const r = await FlyAPI.getRoom(roomNo);
      currentRoom = r.room;
      if (r.room.status === 'playing') { switchView('game'); planeShown = {}; prevSnap = {}; }
      else switchView('room');
      renderRoom(r.room); connectWS();
      toast(I18N.T('已进入观战'));
    } catch (e) { toast(I18N.T('观战失败：') + apiErrMsg(e)); }
  };

  $('btnLb').onclick = async () => {
    $('lbMine').innerHTML = '';
    if (!$('lbNick').value) $('lbNick').value = state.nick || '';
    if ($('lbBoard')) $('lbBoard').hidden = false;
    await loadBoard($('lbBoard') ? $('lbBoard').value : 'winRate');
    $('modal-lb').classList.add('show');
    if ($('lbNick').value) queryPlayerStats($('lbNick').value);
  };
  // v17 榜单维度：winRate 用旧渲染（段位/胜率列）；kills/streak/sign 用统一渲染
  let lbBoardsCache = null;
  function renderBoardGeneric(list, main) {
    const box = $('lbList');
    if (!list.length) { box.innerHTML = '<div class="lb-empty">' + I18N.T('这个榜单还没有数据，快来抢占头名！') + '</div>'; return; }
    const MAIN = {
      kills: (p) => `${p.kills} ${I18N.T('击落')}`,
      streak: (p) => `${p.bestStreak} ${I18N.T('连胜')}`,
      sign: (p) => `${p.signStreak} ${I18N.T('天')}`,
    };
    box.innerHTML = list.map((p, i) => `
      <div class="lb-row" data-nick="${escapeHtml(p.nick)}"${p.nick === state.nick ? ' style="outline:1px solid #8a7dff;border-radius:10px"' : ''}>
        <span class="lb-rank lb-${i < 3 ? 'top' + (i + 1) : 'n'}">${i + 1}</span>
        <span class="lb-nick">${escapeHtml(p.nick)}${p.nick === state.nick ? ' <em class="lb-streak">' + I18N.T('我') + '</em>' : ''}</span>
        <span class="lb-stat lb-wr">${(MAIN[main] || (() => ''))(p)}</span>
        <span class="lb-stat">${main === 'sign' ? I18N.T('连续签到') : (p.games || 0) + I18N.T('局')}</span>
      </div>`).join('');
    box.querySelectorAll('.lb-row').forEach((row) => {
      row.onclick = () => { $('lbNick').value = row.dataset.nick; queryPlayerStats(row.dataset.nick); };
    });
  }
  async function loadBoard(board) {
    board = board || 'winRate';
    if (board === 'winRate') {
      try {
        const res = await fetch('/api/stats/top?n=10').then((r) => r.json());
        renderLeaderboard(res.list || []);
      } catch (e) { $('lbList').innerHTML = '<div class="lb-empty">加载失败</div>'; }
      return;
    }
    try {
      if (!lbBoardsCache) lbBoardsCache = await fetch('/api/stats/boards?n=10').then((r) => r.json());
      renderBoardGeneric((lbBoardsCache.boards || {})[board] || [], board);
    } catch (e) { $('lbList').innerHTML = '<div class="lb-empty">加载失败</div>'; }
  }
  // ================= v31 今日待办（留存清单） =================
  async function renderTodoCard() {
    const box = $('todoList');
    if (!box || !state.nick) { if (box) box.innerHTML = '<div class="todo-row">' + I18N.T('输入昵称后开启你的每日清单') + '</div>'; return; }
    const items = [];
    try {
      const [sg, dl, pz] = await Promise.all([
        jget('/api/stats/player?nick=' + encodeURIComponent(state.nick)),
        jget('/api/daily?nick=' + encodeURIComponent(state.nick)),
        jget('/api/puzzle/today?nick=' + encodeURIComponent(state.nick)),
      ]);
      const signed = (sg.player && sg.player.signDate) === new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      items.push({ done: signed, text: I18N.T('每日签到（+金币）'), act: () => { if ($('btnSign')) $('btnSign').click(); } });
      const daily = dl.daily || {};
      const anyTask = (daily.tasks || []).some((t) => t.done);
      items.push({ done: !!daily.claimed, text: anyTask ? I18N.T('领取每日任务奖励') : I18N.T('完成对局解锁每日任务'), act: anyTask ? () => { if ($('btnDailyClaim')) $('btnDailyClaim').click(); } : null });
      items.push({ done: !!(pz.puzzle && pz.puzzle.solved), text: I18N.T('每日残局（固定骰序解谜）'), act: () => { if ($('btnPuzzle')) $('btnPuzzle').click(); } });
      items.push({ done: false, text: I18N.T('打一场锦标赛（8 人单败）'), act: () => { if ($('btnTour')) $('btnTour').click(); } });
    } catch (e) { box.innerHTML = '<div class="todo-row">' + I18N.T('加载失败') + '</div>'; return; }
    const allDone = items.every((i) => i.done);
    box.innerHTML = items.map((i) =>
      '<div class="todo-row' + (i.done ? ' done' : '') + '"><i>' + (i.done ? '✅' : '⬜') + '</i><span>' + escapeHtml(i.text) + '</span>'
      + (!i.done && i.act ? '<button class="todo-go">' + I18N.T('去完成') + '</button>' : '') + '</div>').join('')
      + (allDone ? '<div class="todo-all">' + I18N.T('🎉 今日清单全清！') + '</div>' : '');
    box.querySelectorAll('.todo-row').forEach((row, i) => {
      const go = row.querySelector('.todo-go');
      if (go && items[i]) go.onclick = items[i].act;
    });
  }

  // ================= v21 锦标赛 =================
  async function openTournament() {
    $('modal-tour').classList.add('show');
    await renderTournament();
  }
  async function renderTournament() {
    const box = $('tourBody');
    if (!box) return;
    const nick = state.nick || '';
    let t = null;
    try {
      const r = await jget('/api/tournament?nick=' + encodeURIComponent(nick));
      t = r.t;
    } catch (e) { box.innerHTML = '<div class="lb-empty">加载失败</div>'; return; }
    const roster = (list, mine) => (list || []).map((n) =>
      '<span class="tour-seed' + (n === nick ? ' me' : '') + '">' + escapeHtml(n) + '</span>').join('');
    let html = '';
    if (!t) {
      html = `
        <p class="tip">8 位棋手 · 两个半区各 4 人一桌 · 各取前 2 晋级决赛。<br>
        半区赛对手强度 2-3，决赛对手全是硬茬（2-3 级）。<br>
        奖励：🏆 冠军 200 ｜ 🥈 亚军 80 ｜ 决赛 3-4 名 40 ｜ 半区赛止步 10（金币）。每日最多报名 3 次。</p>
        <button id="btnTourJoin" class="primary" style="width:100%">${I18N.T('立刻报名参赛')}</button>`;
    } else if (t.stage === 'semi') {
      html = '<p class="tip">' + I18N.T('半区赛进行中——赢下前 2 名晋级决赛！') + '</p>'
        + '<div class="tour-round">🅰 ' + I18N.T('你的半区') + '</div<div class="tour-roster">' + roster(t.semi.groupA) + '</div>'
        + '<div class="tour-round">🅱 ' + I18N.T('另一半区（引擎模拟中）') + '</div<div class="tour-roster">' + roster(t.semi.groupB) + '</div>'
        + '<button id="btnTourJoin" class="primary" style="width:100%">' + (t.roomNo ? I18N.T('回到我的半区赛') : I18N.T('重开半区赛')) + '</button>';
    } else if (t.stage === 'final') {
      html = '<p class="tip">' + I18N.T('晋级决赛！决赛打完按名次发奖。') + '</p>'
        + '<div class="tour-round">' + I18N.T('半决赛晋级名单') + '</div<div class="tour-roster">'
        + roster([t.nick].concat(t.semi.qualifiedA.filter((n) => n !== t.nick))) + roster(t.semi.qualifiedB) + '</div>'
        + '<button id="btnTourJoin" class="primary" style="width:100%">' + (t.roomNo ? I18N.T('回到决赛') : I18N.T('重开决赛')) + '</button>';
    } else {
      html = (t.champion
        ? '<div class="tour-champ">🏆 ' + I18N.T('恭喜夺冠！奖励 +{n} 金币已发放').replace('{n}', t.reward) + '</div>'
        : '<p class="tip">' + I18N.T('上次成绩：决赛第 {r} 名 · 奖励 +{n} 金币').replace('{r}', (t.final.rank || '-')).replace('{n}', t.reward) + '</p>')
        + '<button id="btnTourJoin" class="primary" style="width:100%">' + I18N.T('再战一届') + '</button>';
    }
    // v26 历届冠军榜
    try {
      const ch = await jget('/api/tournament/champions');
      const list = (ch.list || []).slice(0, 8);
      if (list.length) {
        html += '<div class="tour-round">👑 ' + I18N.T('历届冠军') + '</div<div class="tour-roster tour-champs">'
          + list.map((c) => '<span class="tour-seed champ">' + escapeHtml(c.nick) + (c.count > 1 ? ' ×' + c.count : '') + '</span>').join('')
          + '</div>';
      }
    } catch (e) { /* 冠军榜加载失败不影响主界面 */ }
    box.innerHTML = html;
    const btn = $('btnTourJoin');
    if (btn) btn.onclick = () => doTourJoin();
  }
  async function doTourJoin() {
    if (!needNick()) return;
    const btn = $('btnTourJoin');
    if (btn) { btn.disabled = true; btn.textContent = I18N.T('匹配对手中…'); }
    try {
      const r = await jpost('/api/tournament/join', { nick: state.nick });
      if (!r.ok) { toast(apiErrMsg({ message: r.error })); if (btn) { btn.disabled = false; btn.textContent = '立刻报名参赛'; } return; }
      $('modal-tour').classList.remove('show');
      state.roomNo = r.roomNo; state.seat = 0; state.clientId = r.hostClientId; state.spectator = false; saveState();
      const rr = await FlyAPI.getRoom(r.roomNo);
      currentRoom = rr.room;
      switchView('game');
      planeShown = {}; prevSnap = {};
      renderRoom(rr.room);
      connectWS();
      toast(r.stage === 'final' ? I18N.T('决赛开始！前 2 名晋级的是你') : I18N.T('半区赛开始！前 2 名晋级决赛'));
    } catch (e) { toast(I18N.T('报名失败：') + apiErrMsg(e)); if (btn) { btn.disabled = false; btn.textContent = I18N.T('立刻报名参赛'); } }
  }
  if ($('btnTour')) $('btnTour').onclick = openTournament;
  renderTodoCard(); // v31 启动即加载今日待办
  window.addEventListener('langchange', () => { // v36/v39 切语言重渲染
    renderTodoCard();
    if ($('modal-tour').classList.contains('show')) renderTournament();
    if ($('view-lobby').classList.contains('active')) { loadRoomHall(); loadReplayHall(); }
    syncModeTip();
  });

  // v32 前端异常上报：页面错误直达服务器审计（每会话最多 10 条，防刷）
  let errReported = 0;
  const reportErr = (msg, stack) => {
    if (errReported >= 10 || !msg) return;
    errReported += 1;
    try {
      fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg: String(msg).slice(0, 200), stack: String(stack || '').slice(0, 600), page: location.pathname }) });
    } catch (e) { /* ignore */ }
  };
  window.addEventListener('error', (e) => reportErr(e.message, e.error && e.error.stack));
  window.addEventListener('unhandledrejection', (e) => reportErr('unhandledrejection: ' + ((e.reason && (e.reason.message || e.reason)) || '?'), e.reason && e.reason.stack));
  if ($('btnTourClose')) $('btnTourClose').onclick = () => $('modal-tour').classList.remove('show');

  // v17 名人堂：往月赛季前三（自动结算归档）
  async function loadHall() {
    const b = $('lbHall');
    if (!b) return;
    try {
      const r = await fetch('/api/stats/hall').then((x) => x.json());
      const hall = r.hall || [];
      if (!hall.length) { b.innerHTML = '<div class="lb-empty">' + I18N.T('还没有赛季结算记录') + '<br><span style="opacity:.6">' + I18N.T('每月初自动结算上月赛季，前三名登堂并获金币奖励') + '</span></div>'; return; }
      b.innerHTML = hall.map((h) => `
        <div style="margin-bottom:12px">
          <div style="opacity:.7;font-size:13px;margin:2px 0 6px">📅 ${escapeHtml(h.season)} 赛季</div>
          ${(h.champions || []).map((c, i) => `
            <div class="lb-row"${c.nick === state.nick ? ' style="outline:1px solid #8a7dff;border-radius:10px"' : ''}>
              <span class="lb-rank lb-top${i + 1}">${['🥇', '🥈', '🥉'][i] || (i + 1)}</span>
              <span class="lb-nick">${escapeHtml(c.nick)}${c.nick === state.nick ? ' <em class="lb-streak">我</em>' : ''}</span>
              <span class="lb-stat lb-wr hot">+${c.bonus} 金币</span>
            </div>`).join('')}
        </div>`).join('');
    } catch (e) { b.innerHTML = '<div class="lb-empty">加载失败</div>'; }
  }
  // ================= v18 战报中心（站内信） =================
  const TITLE_BASE = I18N.T('飞行棋 · 在线对战');
  async function loadMailBadge() {
    if (!state.nick) return;
    try {
      const r = await jget('/api/mail?nick=' + encodeURIComponent(state.nick));
      const dot = $('mailDot');
      if (dot) dot.hidden = !r.unread;
      document.title = r.unread ? '(' + r.unread + ') ' + TITLE_BASE : TITLE_BASE; // v19 标签页未读提醒
    } catch (e) { /* 静默 */ }
  }
  function mailTitle(m) {
    if (m.kind === 'system') return '📢 ' + escapeHtml(m.title || I18N.T('系统通知'));
    if (m.kind === 'tournament') {
      if (m.champion) return I18N.T('🏆 锦标赛冠军！奖励 +{n} 金币').replace('{n}', m.reward || 0);
      if (m.stage === 'final') return I18N.T('决赛第 {r} 名 · 奖励 +{n} 金币').replace('{r}', m.rank || '?').replace('{n}', m.reward || 0);
      return m.advanced ? I18N.T('锦标赛晋级决赛！') : I18N.T('止步半区赛 · 安慰奖 +{n} 金币').replace('{n}', m.reward || 0);
    }
    if (m.kind === 'season') return '🏅 ' + escapeHtml(m.season || '') + ' ' + I18N.T('赛季第 {r} 名 · 奖励 +{n} 金币').replace('{r}', m.rank || '?').replace('{n}', m.bonus || 0);
    if (m.kind === 'achievement') {
      const names = (m.achs || []).map((a) => a.icon + ' ' + a.name).join('、');
      return I18N.T('🎖️ 成就解锁') + (names ? I18N.T('：') + names : '');
    }
    if (m.pveLevel) return m.isWinner ? I18N.T('闯关成功 · 第 {n} 关').replace('{n}', m.pveLevel) : I18N.T('闯关失利 · 第 {n} 关').replace('{n}', m.pveLevel);
    if (m.isWinner) return I18N.T('🏆 对局获胜');
    return I18N.T('对局结束 · 第 {r} 名').replace('{r}', m.rank || '?');
  }
  let currentMailList = [];
  function openWallFor(nick) {
    if (!nick) return;
    $('modal-mail').classList.remove('show');
    $('lbNick').value = nick;
    $('modal-lb').classList.add('show');
    document.querySelectorAll('.lb-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'wall'));
    $('lbWall').hidden = false; $('lbList').hidden = true; $('lbSeason').hidden = true; $('lbHall').hidden = true; $('lbMine').hidden = true;
    if ($('lbBoard')) $('lbBoard').hidden = true;
    queryPlayerStats(nick);
  }
  function renderMail(list) {
    currentMailList = list || [];
    const box = $('mailList');
    if (!box) return;
    if (!list.length) { box.innerHTML = '<div class="lb-empty">' + I18N.T('还没有战报，打一局就有了！') + '</div>'; return; }
    box.innerHTML = list.map((m) => {
      const icon = m.kind === 'system' ? '📢' : m.kind === 'season' ? '🏅' : m.kind === 'tournament' ? '🏆' : m.kind === 'achievement' ? ((m.achs && m.achs[0] && m.achs[0].icon) || '🎖️') : (m.isWinner ? '🏆' : (m.pveLevel ? '⚔️' : '✈️'));
      const sub = m.kind === 'system'
        ? escapeHtml(m.text || '') + (m.coins ? ' · 🪙+' + m.coins : '') + ' · ' + new Date(m.at).toLocaleString('zh-CN')
        : m.kind === 'tournament'
        ? (m.champion ? I18N.T('登顶名人堂') : I18N.T('赛程结束')) + ' · ' + new Date(m.at).toLocaleString('zh-CN')
        : m.kind === 'season'
        ? I18N.T('名人堂已收录 · ') + new Date(m.at).toLocaleString('zh-CN')
        : m.kind === 'achievement'
        ? I18N.T('成就解锁 · ') + escapeHtml(m.roomNo || '') + ' · ' + new Date(m.at).toLocaleString('zh-CN')
        : I18N.T('击落 {a} · 被击落 {b} · 到家 {c} · {s} 赛季 · ').replace('{a}', m.kills || 0).replace('{b}', m.beenKilled || 0).replace('{c}', m.finishedCount || 0).replace('{s}', escapeHtml(m.season || '')) + new Date(m.at).toLocaleString('zh-CN');
      const replayBtn = m.roomNo ? '<button class="mi-replay" data-no="' + escapeHtml(m.roomNo) + '" title="' + I18N.T('回放本局') + '">▶ ' + I18N.T('回放') + '</button>' : '';
      return `
      <div class="mail-item${m.read ? '' : ' unread'}">
        <span class="mi-icon">${icon}</span>
        <span class="mi-main">
          <span class="mi-title">${escapeHtml(mailTitle(m))}</span>
          <span class="mi-sub">${sub}</span>
        </span>
        ${replayBtn}
      </div>`;
    }).join('');
    box.querySelectorAll('.mi-replay').forEach((b) => { b.onclick = () => openReplay(b.dataset.no); });
    // v20 成就战报点击直达该玩家成就墙
    box.querySelectorAll('.mail-item').forEach((item, i) => {
      const m = currentMailList[i];
      if (!m || m.kind !== 'achievement') return;
      item.classList.add('clickable');
      item.onclick = (ev) => {
        if (ev.target.closest('.mi-replay')) return;
        openWallFor(state.nick || '');
      };
    });
  }
  async function loadMail(markRead) {
    if (!state.nick) { toast(I18N.T('请先在大厅输入昵称')); return; }
    const box = $('mailList');
    try {
      const r = await jget('/api/mail?nick=' + encodeURIComponent(state.nick));
      renderMail(r.list || []);
      if (markRead && r.unread) {
        try { await jpost('/api/mail/read', { nick: state.nick }); } catch (e) { /* ignore */ }
      }
      loadMailBadge();
    } catch (e) { if (box) box.innerHTML = '<div class="lb-empty">加载失败</div>'; }
  }
  if ($('btnMail')) $('btnMail').onclick = () => { $('modal-mail').classList.add('show'); loadMail(true); };
  if ($('btnMailClose')) $('btnMailClose').onclick = () => $('modal-mail').classList.remove('show');
  loadMailBadge();

  // ================= v18 PWA 安装横幅（Chromium 系触发；iOS 用分享菜单添加） =================
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    if ($('installBar') && !state.installDismissed) $('installBar').hidden = false;
  });
  window.addEventListener('appinstalled', () => { if ($('installBar')) $('installBar').hidden = true; });
  if ($('btnInstallGo')) $('btnInstallGo').onclick = async () => {
    try { if (deferredInstall) { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; } } catch (e) { /* ignore */ }
    if ($('installBar')) $('installBar').hidden = true;
  };
  if ($('btnInstallSkip')) $('btnInstallSkip').onclick = () => {
    state.installDismissed = true; saveState();
    if ($('installBar')) $('installBar').hidden = true;
  };

  function renderLeaderboard(list) {
    const box = $('lbList');
    if (!list.length) { box.innerHTML = '<div class="lb-empty">还没有战绩，快来打一局！</div>'; return; }
    box.innerHTML = list.map((p, i) => `
      <div class="lb-row" data-nick="${escapeHtml(p.nick)}"${p.nick === state.nick ? ' style="outline:1px solid #8a7dff;border-radius:10px"' : ''}>
        <span class="lb-rank lb-${i < 3 ? 'top' + (i + 1) : 'n'}">${i + 1}</span>
        <span class="lb-tier" title="${escapeHtml(p.tierName || I18N.T('青铜'))}">${p.tierIcon || '🥉'}</span>
        <span class="lb-nick">${escapeHtml(p.nick)}${badgeHtml(p.badges)}${p.nick === state.nick ? ' <em class="lb-streak">' + I18N.T('我') + '</em>' : ''}${p.streak >= 3 ? `<em class="lb-streak">${p.streak}${I18N.T('连胜')}</em>` : ''}</span>
        <span class="lb-stat">${p.games}${I18N.T('局')}</span>
        <span class="lb-stat">${p.wins}${I18N.T('胜')}</span>
        <span class="lb-stat lb-wr ${p.winRate >= 50 ? 'hot' : ''}">${p.winRate}%</span>
      </div>`).join('');
    // 点榜单任意一行 → 直接查 TA 的个人战绩
    box.querySelectorAll('.lb-row').forEach((row) => {
      row.onclick = () => { $('lbNick').value = row.dataset.nick; queryPlayerStats(row.dataset.nick); };
    });
  }
  /** 个人战绩：汇总卡 + 最近 5 局明细 */
  async function queryPlayerStats(nick) {
    const box = $('lbMine');
    nick = String(nick || '').trim();
    if (!nick) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="lb-empty">查询中…</div>';
    try {
      const res = await fetch('/api/stats/player?nick=' + encodeURIComponent(nick)).then((r) => r.json());
      if (!res.player) { box.innerHTML = `<div class="lb-empty">「${escapeHtml(nick)}」还没有战绩</div>`; return; }
      const p = res.player;
  // v24 个人战绩走势：最近 20 局名次折线（1 最好）
  function renderTrendSpark(parent, history) {
    if (!parent || !history || history.length < 2) return;
    const hs = history.slice(0, 20).reverse(); // 旧→新
    const W = 260, H = 46, pad = 4;
    const xs = (i) => pad + (i * (W - pad * 2)) / (hs.length - 1);
    const ys = (r) => pad + ((r - 1) * (H - pad * 2)) / 3;
    const pts = hs.map((h, i) => xs(i).toFixed(1) + ',' + ys(h.rank).toFixed(1)).join(' ');
    const dots = hs.map((h, i) =>
      '<circle cx="' + xs(i).toFixed(1) + '" cy="' + ys(h.rank).toFixed(1) + '" r="' + (h.isWinner ? 3.2 : 2) + '" fill="' + (h.isWinner ? '#f5b93c' : 'rgba(255,255,255,.55)') + '"/>').join('');
    parent.insertAdjacentHTML('afterbegin',
      '<div class="trend-box"><div class="trend-title">' + I18N.T('近 {n} 局名次走势（🟡=获胜）').replace('{n}', hs.length) + '</div>'
      + '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" class="trend-svg">'
      + '<polyline points="' + pts + '" fill="none" stroke="rgba(138,125,255,.9)" stroke-width="1.6" stroke-linejoin="round"/>'
      + dots + '</svg></div>');
  }
      const hist = (p.history || []).slice(0, 5).map((h) => `
        <div class="m-hist-row">
          <span class="m-dot" style="background:${Board.COLOR_HEX[h.color] || '#888'}"></span>
          <span class="${h.isWinner ? 'm-win' : ''}">${h.isWinner ? I18N.T('🏆 冠军') : I18N.T('第{r}').replace('{r}', h.rank)}</span>
          <span class="m-dim">🛬${h.finishedCount} 💥${h.kills}</span>
          <span class="m-dim m-time">${fmtTime(h.endedAt)}</span>
        </div>`).join('');
      const nextTxt = p.winsToNext > 0
        ? I18N.T('再赢 <b>{n}</b> 场升段').replace('{n}', p.winsToNext)
        : I18N.T('已达最高段位 👑');
      box.innerHTML = `
        <div class="m-card">
          <div class="m-tier" style="--tc:${p.tierColor || '#f0b429'}">
            <span class="mt-ico">${p.tierIcon || '🥉'}</span>
            <div class="mt-info">
              <div class="mt-name">${escapeHtml(p.tierName || I18N.T('青铜'))}<em>${p.wins} ${I18N.T('胜')}</em></div>
              <div class="mt-bar"><i style="width:${Math.round((p.tierProgress || 0) * 100)}%"></i></div>
            </div>
            <span class="mt-next">${nextTxt}</span>
          </div>
          <div class="m-head"><b>${escapeHtml(p.nick)}</b><span class="m-wr">胜率 ${p.winRate}%</span></div>
          <div class="m-grid">
            <div><span>${p.games}</span><i>总局数</i></div>
            <div><span>${p.wins}</span><i>胜场</i></div>
            <div><span>${p.kills}</span><i>击落</i></div>
            <div><span>${p.streak || 0}</span><i>连胜</i></div>
            <div><span>${p.bestStreak || 0}</span><i>最高连胜</i></div>
          </div>
          ${hist ? `<div class="m-hist"><div class="m-hist-t">最近对局</div>${hist}</div>` : ''}
          <canvas id="profileChart" class="m-chart" width="600" height="240"></canvas>
        </div>`;
      renderTrendSpark(box, p.history); // v24 名次走势
            renderAchWall(p);
      drawProfileChart(p);
    } catch (e) { box.innerHTML = '<div class="lb-empty">查询失败</div>'; }
  }

  // ================= v12 个人战绩数据看板（Canvas 图表） =================
  function drawProfileChart(p) {
    const cv = $('profileChart'); if (!cv || !p) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    // 胜率环形
    const cx = 72, cy = H / 2, r = 48;
    const rate = p.games > 0 ? p.wins / p.games : 0;
    ctx.lineWidth = 15; ctx.strokeStyle = '#e3e8f5';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#6a5cff';
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + rate * Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#262c66'; ctx.font = 'bold 24px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(p.winRate + '%', cx, cy - 6);
    ctx.fillStyle = '#8a90b0'; ctx.font = '12px sans-serif'; ctx.fillText(I18N.T('胜率'), cx, cy + 18);
    // 击落 vs 被击落 双柱
    const bx = 178, bw = 38, gap = 26, baseY = H - 34;
    const maxK = Math.max(p.kills, p.beenKilled, 1);
    const drawBar = (x, val, color, label) => {
      const h = Math.min((val / maxK) * (H - 100), H - 100);
      ctx.fillStyle = color; ctx.fillRect(x, baseY - h, bw, h);
      ctx.fillStyle = '#8a90b0'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(String(val), x + bw / 2, baseY - h - 8);
      ctx.fillText(label, x + bw / 2, baseY + 16);
    };
    drawBar(bx, p.kills, '#ff7a59', I18N.T('击落'));
    drawBar(bx + bw + gap, p.beenKilled, '#9aa0c0', I18N.T('被击'));
    ctx.fillStyle = '#262c66'; ctx.font = '13px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(I18N.T('🔥 连胜 {a}　🏆 最高 {b}').replace('{a}', p.streak || 0).replace('{b}', p.bestStreak || 0), 178, 22);
    ctx.fillText(I18N.T('🎲 六点 {a}　💥 单局最高击落 {b}').replace('{a}', p.sixes || 0).replace('{b}', p.bestKills || 0), 178, 44);
  }

  // ================= v12 新手引导 =================
  const GUIDE_STEPS = [
    { t: I18N.T('🎲 掷骰起飞'), d: I18N.T('每回合先掷骰，掷出 6 才能把飞机送上起飞点。可邀请好友实时对战，或单挑 3 台电脑 AI，打开就能玩。') },
    { t: I18N.T('✈️ 撞子与归航'), d: I18N.T('落在敌机所在格把它撞回基地，并获额外掷骰；绕场一周进入归航道，最先让 4 架飞机全部到家者获胜。') },
    { t: I18N.T('🏆 成长与社交'), d: I18N.T('每日签到领金币、做任务拿道具卡；打系列赛争总冠军；加好友随时邀战。设置里可调音效、动画速度与棋盘皮肤。') },
  ];
  let guideIdx = 0;
  function showGuide() { guideIdx = 0; renderGuide(); $('guide').hidden = false; }
  function closeGuide() { $('guide').hidden = true; state.firstGuide = true; saveState(); }
  function guideNext() { guideIdx += 1; if (guideIdx >= GUIDE_STEPS.length) closeGuide(); else renderGuide(); }
  function renderGuide() {
    const s = GUIDE_STEPS[guideIdx]; const b = $('guideBody');
    if (b) b.innerHTML = `<div class="g-emoji">${s.t}</div><div class="g-txt">${s.d}</div><div class="g-dots">${GUIDE_STEPS.map((_, i) => `<i class="${i === guideIdx ? 'on' : ''}"></i>`).join('')}</div>`;
    const n = $('guideNext'); if (n) n.textContent = guideIdx >= GUIDE_STEPS.length - 1 ? I18N.T('开始游戏') : I18N.T('下一步');
  }

  // ================= v12 每日任务 =================
  async function loadDaily() {
    if (!state.nick) { toast(I18N.T('先在「我的」设置昵称')); return; }
    try {
      const res = await fetch('/api/daily?nick=' + encodeURIComponent(state.nick)).then((r) => r.json());
      renderDaily(res.daily);
    } catch (e) { /* ignore */ }
  }
  function renderDaily(d) {
    if (!d) return;
    const el = $('dailyDate'); if (el) el.textContent = I18N.T('日期 {d}').replace('{d}', d.date) + (d.claimed ? I18N.T(' · 今日已领取 ✅') : '');
    const box = $('dailyList'); if (!box) return;
    box.innerHTML = d.tasks.map((t) => `
      <div class="dl-item ${t.done ? 'on' : ''}">
        <span class="dl-check">${t.done ? '✓' : '○'}</span>
        <div class="dl-info"><b>${t.name}</b><i>${t.desc}</i></div>
        <span class="dl-rew">${t.reward}</span>
      </div>`).join('');
  }
  async function doClaimDaily() {
    if (!state.nick) { toast(I18N.T('先设置昵称')); return; }
    try {
      const res = await fetch('/api/daily/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nick: state.nick }) }).then((r) => r.json());
      if (res.ok) {
        toast(res.already ? I18N.T('今日已领取') : I18N.T('领取成功！') + (res.coins ? I18N.T(' +{n} 金币').replace('{n}', res.coins) : '') + (res.prop ? I18N.T(' 🎁道具卡') : ''));
        if (res.coins) updateCoin(res.coins);
        const d = await fetch('/api/daily?nick=' + encodeURIComponent(state.nick)).then((r) => r.json()).then((x) => x.daily);
        renderDaily(d);
      } else toast(I18N.T('领取失败：') + (res.error || ''));
    } catch (e) { toast(I18N.T('领取失败')); }
  }

  /** v7 成就墙：10 个成就的解锁状态 */
  function renderAchWall(p) {
    const box = $('lbWall');
    if (!box) return;
    if (!p || !p.wall || !p.wall.length) {
      box.innerHTML = '<div class="lb-empty">输入昵称查询后即可查看成就墙</div>';
      return;
    }
    const got = p.wall.filter((a) => a.unlocked).length;
    box.innerHTML = `<div class="aw-summary">已解锁 <b>${got}</b>/${p.wall.length} · 累计六点 <b>${p.sixes || 0}</b> · 单局最高击落 <b>${p.bestKills || 0}</b></div>`
      + '<div class="aw-grid">' + p.wall.map((a) => `
        <div class="aw-item ${a.unlocked ? 'on' : ''}">
          <span class="aw-ico">${a.icon}</span>
          <div class="aw-txt"><b>${a.name}</b><i>${a.desc}</i></div>
          ${(!a.unlocked && a.progress) ? '<em class="aw-prog">' + a.progress.cur + '/' + a.progress.goal + '</em><i class="aw-bar"><b style="width:' + Math.round(a.progress.cur / a.progress.goal * 100) + '%"></b></i>' : ''}
          ${a.unlocked ? '<span class="aw-tick">✓</span>' : ''}
        </div>`).join('') + '</div>';
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }
  $('btnLbQuery').onclick = () => queryPlayerStats($('lbNick').value);

  // v19 回放直达：?replay=房号（战报按钮与分享链接共用入口）
  try {
    const rpNo = new URLSearchParams(location.search).get('replay');
    if (rpNo) setTimeout(() => openReplay(String(rpNo).replace(/[^0-9]/g, '')), 400);
  } catch (e) { /* ignore */ }

  // v19 复制回放分享链接
  if ($('btnReplayLink')) $('btnReplayLink').onclick = () => {
    const no = replay.roomNo || state.roomNo;
    if (!no) { toast(I18N.T('暂无可分享的回放')); return; }
    copyText(location.origin + '/?replay=' + no);
    toast(I18N.T('回放链接已复制，发给好友一起看'));
  };
  $('lbNick').onkeydown = (e) => { if (e.key === 'Enter') queryPlayerStats($('lbNick').value); };
  $('btnLbClose').onclick = () => $('modal-lb').classList.remove('show');
  // v7 战绩弹窗：排行榜 / 本赛季 / 名人堂 / 成就墙 / 我的 切换（v17 增名人堂与榜单维度）
  document.querySelectorAll('.lb-tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.lb-tab').forEach((x) => x.classList.toggle('active', x === t));
      const tab = t.dataset.tab;
      $('lbWall').hidden = tab !== 'wall';
      $('lbList').hidden = tab !== 'rank';
      $('lbSeason').hidden = tab !== 'season';
      $('lbHall').hidden = tab !== 'hall';
      $('lbMine').hidden = tab !== 'my';
      if ($('lbBoard')) $('lbBoard').hidden = tab !== 'rank';
      if (tab === 'season') loadSeason();
      if (tab === 'hall') loadHall();
      if (tab === 'rank') loadBoard($('lbBoard') ? $('lbBoard').value : 'winRate');
      if (tab === 'my') {
        if (!$('lbNick').value) $('lbNick').value = state.nick || '';
        queryPlayerStats($('lbNick').value);
      }
    };
  });
  if ($('lbBoard')) $('lbBoard').onchange = () => loadBoard($('lbBoard').value);

  // ================= v8 社交留存：皮肤 / 签到 / 赛季 / 公告 =================
  const SKIN_MAP = {
    classic: { name: I18N.T('经典极光'), theme: '#6a5cff', colorHex: null, tileHex: null },
    aurora:  { name: I18N.T('极光紫'), theme: '#9b6cff', colorHex: { red: '#ff6fae', yellow: '#caa0ff', blue: '#7ab0ff', green: '#5fe0b0' }, tileHex: { red: '#f25f9e', yellow: '#b07fe8', blue: '#3f8af0', green: '#23bf7e' } },
    sunset:  { name: I18N.T('落日橙'), theme: '#ff7a59', colorHex: { red: '#ff6a5a', yellow: '#ffb24d', blue: '#ff8a5b', green: '#ffb24d' }, tileHex: { red: '#f4495d', yellow: '#f2901c', blue: '#f4722f', green: '#e0a01c' } },
    forest:  { name: I18N.T('森野绿'), theme: '#3fae7a', colorHex: { red: '#ff7a8a', yellow: '#bfe05a', blue: '#4ad0c0', green: '#46d68a' }, tileHex: { red: '#f4495d', yellow: '#9bc41c', blue: '#2fb0c0', green: '#27bf68' } },
    midnight: { name: I18N.T('暗夜蓝'), theme: '#4f7bff', colorHex: { red: '#ff6f8a', yellow: '#9aa6ff', blue: '#5b8cff', green: '#6fe0c0' }, tileHex: { red: '#f4495d', yellow: '#5a6ae0', blue: '#3f6cff', green: '#27bf9e' } },
  };
  window.__SKIN_COLORS__ = SKIN_MAP; // 供 board.js setSkin 读取
  function applySkin(id) {
    id = id || 'classic';
    const s = SKIN_MAP[id] || SKIN_MAP.classic;
    document.documentElement.style.setProperty('--brand', s.theme);
    try { Board.setSkin(id); } catch (e) { /* ignore */ }
    if (currentGame) animatePlanes(currentGame);
  }
  function updateCoin(n) { const e = $('coinNum'); if (e) e.textContent = '🪙' + (n || 0); }
  async function doSign() {
    const nick = (state.nick || I18N.T('玩家')).trim();
    try {
      const r = await jpost('/api/sign', { nick });
      if (r.ok) { updateCoin(r.coins); toast(r.signed ? I18N.T('签到成功 +{n} 金币（连签 {d} 天）').replace('{n}', r.reward).replace('{d}', r.streak) : I18N.T('今天已签到')); }
      else toast(I18N.T('签到失败'));
    } catch (e) { toast(I18N.T('签到失败')); }
  }
  async function loadSkins() {
    try {
      const [sk, pl] = await Promise.all([
        fetch('/api/shop/skins').then((x) => x.json()),
        fetch('/api/stats/player?nick=' + encodeURIComponent(state.nick || '')).then((x) => x.json()),
      ]);
      const owned = (pl.player && pl.player.skins) || ['classic'];
      const equipped = (pl.player && pl.player.equipped) || 'classic';
      if (pl.player) updateCoin(pl.player.coins || 0);
      const list = $('shopList');
      list.innerHTML = (sk.skins || []).map((s) => {
        const has = owned.indexOf(s.id) >= 0; const eq = equipped === s.id;
        const act = has
          ? (eq ? '<span class="si-eq">使用中</span>' : `<button class="si-btn equip" data-id="${s.id}">装备</button>`)
          : `<button class="si-btn buy" data-id="${s.id}" data-price="${s.price}">🪙${s.price}</button>`;
        return `<div class="shop-item${eq ? ' on' : ''}"><div class="si-sw" style="--c:${s.theme}"></div>`
          + `<div class="si-info"><b>${s.name}</b><i>${s.desc}</i></div><div class="si-act">${act}</div></div>`;
      }).join('');
      list.querySelectorAll('.buy').forEach((b) => { b.onclick = () => buySkin(b.dataset.id); });
      list.querySelectorAll('.equip').forEach((b) => { b.onclick = () => equipSkin(b.dataset.id); });
      // v12 道具卡：渲染可购买列表，开局自动携带
      const myProps = (pl.player && pl.player.props) || [];
      const pcoins = (pl.player && pl.player.coins) || 0;
      const pres = await fetch('/api/shop/props').then((x) => x.json());
      const pb = $('shopProps');
      if (pb && pres.ok) {
        pb.innerHTML = (pres.props || []).map((p) => {
          const ic = (ITEM_META[p.id] && ITEM_META[p.id].icon) || '🎒';
          const ow = myProps.find((x) => x.id === p.id);
          const act = pcoins >= p.price ? `<button class="si-btn buy" data-pid="${p.id}">🪙${p.price}</button>` : `<button class="si-btn buy" disabled>🪙${p.price}</button>`;
          return `<div class="shop-item"><div class="si-sw" style="--c:#6a5cff">${ic}</div><div class="si-info"><b>${p.name}</b><i>${p.desc}</i></div><div class="si-act">${act}${ow ? `<span class="si-eq">×${ow.count}</span>` : ''}</div></div>`;
        }).join('');
        pb.querySelectorAll('.buy[data-pid]').forEach((b) => { b.onclick = () => buyProp(b.dataset.pid); });
      }
    } catch (e) { /* ignore */ }
  }
  async function buyProp(id) {
    try {
      const r = await fetch('/api/shop/buy-prop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nick: state.nick || '', id }) }).then((x) => x.json());
      if (r.ok) { toast(I18N.T('购买成功，开局自动携带！')); loadSkins(); } else toast(r.error === 'COINS_NOT_ENOUGH' ? I18N.T('金币不足') : I18N.T('购买失败'));
    } catch (e) { toast(I18N.T('购买失败')); }
  }
  async function buySkin(id) {
    try {
      const r = await fetch('/api/shop/buy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nick: state.nick || '', id }) }).then((x) => x.json());
      if (r.ok) { toast(I18N.T('购买成功！')); loadSkins(); } else toast(r.error === 'COINS_NOT_ENOUGH' ? I18N.T('金币不足') : I18N.T('购买失败'));
    } catch (e) { toast(I18N.T('购买失败')); }
  }
  async function equipSkin(id) {
    try {
      const r = await fetch('/api/shop/equip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nick: state.nick || '', id }) }).then((x) => x.json());
      if (r.ok) { applySkin(id); state.equipped = id; saveState(); toast(I18N.T('已装备：') + ((SKIN_MAP[id] || {}).name || id)); loadSkins(); } else toast(I18N.T('装备失败'));
    } catch (e) { toast(I18N.T('装备失败')); }
  }
  async function loadSeason() {
    try {
      const r = await fetch('/api/stats/season?n=10').then((x) => x.json());
      renderSeason(r.list || []);
    } catch (e) { const b = $('lbSeason'); if (b) b.innerHTML = '<div class="lb-empty">加载失败</div>'; }
  }
  function renderSeason(list) {
    const b = $('lbSeason');
    if (!b) return;
    if (!list.length) { b.innerHTML = '<div class="lb-empty">本赛季还没有战绩</div>'; return; }
    b.innerHTML = list.map((p, i) => `
      <div class="lb-row">
        <span class="lb-rank lb-${i < 3 ? 'top' + (i + 1) : 'n'}">${i + 1}</span>
        <span class="lb-nick">${escapeHtml(p.nick)}${p.streak >= 3 ? `<em class="lb-streak">${p.streak}${I18N.T('连胜')}</em>` : ''}</span>
        <span class="lb-stat">${p.games}${I18N.T('局')}</span>
        <span class="lb-stat">${p.wins}${I18N.T('胜')}</span>
        <span class="lb-stat lb-wr ${p.winRate >= 50 ? 'hot' : ''}">${p.winRate}%</span>
      </div>`).join('');
  }
  async function loadAnnounce() {
    try {
      const r = await fetch('/api/announce').then((x) => x.json());
      const b = $('announceBar');
      if (b) { if (r.text) { b.hidden = false; b.textContent = '📢 ' + r.text; } else b.hidden = true; }
    } catch (e) { /* ignore */ }
  }
  /** 活动 banner 轮播：拉 /api/banners 渲染，多张自动切换 */
  async function loadBanners() {
    try {
      const r = await fetch('/api/banners').then((x) => x.json());
      const list = (r && r.banners) || [];
      const box = $('banner');
      if (!box) return;
      if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
      box.hidden = false;
      // v33：url/color 会直插属性，必须白名单校验（后台可配，属存储型 XSS 入口）
      const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
      const safeColor = (c) => (/^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? String(c) : '#6a5cff');
      box.innerHTML = list.map((b, i) => {
        const url = safeUrl(b.url);
        const color = safeColor(b.color);
        return `<a class="bn ${i === 0 ? 'on' : ''}" ${url ? `href="${url}" target="_blank" rel="noopener"` : ''} style="background:${color}">` +
        `<div class="bn-t">${escapeHtml(b.title || '')}</div>` +
        (b.sub ? `<div class="bn-s">${escapeHtml(b.sub || '')}</div>` : '') + `</a>`;
      }).join('');
      if (list.length > 1) {
        let idx = 0;
        clearInterval(box._t);
        box._t = setInterval(() => {
          const els = box.querySelectorAll('.bn');
          if (!els.length) return;
          els[idx].classList.remove('on');
          idx = (idx + 1) % els.length;
          els[idx].classList.add('on');
        }, 3500);
      }
    } catch (e) { /* ignore */ }
  }
  if ($('btnSign')) $('btnSign').onclick = doSign;
  if ($('btnShop')) $('btnShop').onclick = () => { loadSkins(); $('modal-shop').classList.add('show'); };
  if ($('btnShopClose')) $('btnShopClose').onclick = () => $('modal-shop').classList.remove('show');
  if ($('btnProfile')) $('btnProfile').onclick = () => {
    if (!$('lbNick').value) $('lbNick').value = state.nick || '';
    document.querySelectorAll('.lb-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'my'));
    $('lbList').hidden = true; $('lbSeason').hidden = true; $('lbWall').hidden = true; $('lbMine').hidden = false;
    queryPlayerStats($('lbNick').value);
    $('modal-lb').classList.add('show');
  };
  if ($('btnAdmin')) $('btnAdmin').onclick = () => window.open('/admin', '_blank');
  if ($('btnDaily')) $('btnDaily').onclick = () => { loadDaily(); $('modal-daily').classList.add('show'); };
  if ($('btnDailyClose')) $('btnDailyClose').onclick = () => $('modal-daily').classList.remove('show');
  if ($('btnDailyClaim')) $('btnDailyClaim').onclick = doClaimDaily;
  if ($('guideSkip')) $('guideSkip').onclick = closeGuide;
  if ($('guideNext')) $('guideNext').onclick = guideNext;
  if (!state.firstGuide) setTimeout(showGuide, 600);

  // ================= 房间 =================
  function mkBtn(text, fn) {
    const b = document.createElement('button');
    b.textContent = text;
    b.onclick = fn;
    return b;
  }
  function doSetSeat(seat, action, extra) {
    FlyAPI.setSeat(state.roomNo, {
      seat, action, aiLevel: extra && extra.aiLevel, requesterSeat: state.seat,
      hostStyle: extra && extra.hostStyle, // v13 AI 风格
    })
      .then(() => FlyAPI.getRoom(state.roomNo))
      .then((r) => renderRoom(r.room))
      .catch((e) => toast(I18N.T('操作失败：') + e.message));
  }
  function renderRoom(room) {
    if (!room) return;
    currentRoom = room;
    $('roomNoText').textContent = room.roomNo;
    $('roomStatusText').textContent = room.status === 'playing' ? I18N.T('对局进行中')
      : room.status === 'finished' ? I18N.T('已结束') : I18N.T('等待玩家加入…');
    // v10 对局模式徽章
    const dm = (room.settings && Number(room.settings.diceMode)) || 1;
    $('roomModeText').textContent = MODE_LABEL[dm] || MODE_LABEL[1];
    // v11 系列赛徽章：等待/进行中显示「N 局积分赛 · 第 X 局」
    const ser = room.series;
    const serEl = $('roomSeriesText');
    if (ser && ser.rounds > 1) {
      serEl.hidden = false;
      serEl.textContent = `🏆 ${ser.rounds} 局积分赛 · 第 ${ser.current}/${ser.rounds} 局`;
    } else if (serEl) {
      serEl.hidden = true;
    }
    renderRoomRules(room); // v7 #16 房间内规则展示
    renderRulesPanel(room); // v13 自定义规则面板
    const list = $('seatList');
    list.innerHTML = '';
    room.seats.forEach((seat) => {
      const div = document.createElement('div');
      const tm = room.settings && room.settings.teamMode;
      div.className = 'seat ' + (seat.type === 'empty' ? 'is-empty ' : '')
        + (seat.type === 'ai' ? 'is-ai ' : '') + (seat.seat === state.seat ? 'is-you ' : '')
        + (seat.eliminated ? 'is-out ' : '')
        + (tm ? 'team-' + Math.floor(seat.seat / 2) + ' ' : '');
      div.style.setProperty('--sc', Board.COLOR_HEX[seat.color]);
      // v13 AI 风格：座位副标题带上激进/均衡/保守
      const stLabel = STYLE_LABEL[seat.hostStyle] || I18N.T('均衡');
      const typeText = seat.type === 'human' ? (I18N.T('玩家') + (seat.online ? '' : I18N.T('（离线）')))
        : seat.type === 'ai' ? (I18N.T('电脑 Lv') + (seat.aiLevel || 2) + '·' + stLabel) : I18N.T('空位');
      const typeCls = 'seat-type ' + (seat.type === 'human' ? 't-human' : seat.type === 'ai' ? 't-ai' : 't-empty');
      const head = document.createElement('div');
      head.className = 'seat-head';
      head.innerHTML = `<span class="seat-badge"><svg><use href="#i-plane"/></svg></span>`
        + `<span class="seat-name">${escapeHtml(seat.nickName || (seat.type === 'empty' ? I18N.T('空位') : '—'))}</span>`
        + badgeHtml(seat.badges)
        + (seat.seat === state.seat ? '<span class="you-tag">你</span>' : '');
      const sub = document.createElement('div');
      sub.className = typeCls;
      sub.textContent = seat.eliminated ? I18N.T('☠️ 已淘汰') : typeText;
      div.appendChild(head); div.appendChild(sub);

      if (room.ownerSeat === state.seat && seat.seat !== state.seat && room.status !== 'playing') {
        const btns = document.createElement('div');
        btns.className = 'seat-btns';
        if (seat.type === 'empty') {
          btns.appendChild(mkBtn(I18N.T('设电脑'), () => doSetSeat(seat.seat, 'set_ai')));
          btns.appendChild(mkBtn(I18N.T('设玩家'), () => doSetSeat(seat.seat, 'set_human')));
        } else if (seat.type === 'ai') {
          btns.appendChild(mkBtn(I18N.T('设空位'), () => doSetSeat(seat.seat, 'set_empty')));
          btns.appendChild(mkBtn(I18N.T('难度-'), () => doSetSeat(seat.seat, 'set_level', { aiLevel: Math.max(1, (seat.aiLevel || 2) - 1) })));
          btns.appendChild(mkBtn(I18N.T('难度+'), () => doSetSeat(seat.seat, 'set_level', { aiLevel: Math.min(4, (seat.aiLevel || 2) + 1) })));
          // v13 AI 风格切换：均衡 → 激进 → 保守 → 均衡
          btns.appendChild(mkBtn(I18N.T('风格:') + stLabel, () =>
            doSetSeat(seat.seat, 'set_style', { hostStyle: STYLE_NEXT[seat.hostStyle || 'balanced'] })));
        } else {
          btns.appendChild(mkBtn(I18N.T('设电脑'), () => doSetSeat(seat.seat, 'set_ai')));
          btns.appendChild(mkBtn(I18N.T('设空位'), () => doSetSeat(seat.seat, 'set_empty')));
        }
        div.appendChild(btns);
      }
      list.appendChild(div);
    });

    const filled = room.seats.filter((s) => s.type !== 'empty').length;
    const canStart = room.ownerSeat === state.seat && filled === 4 && room.status !== 'playing';
    const btn = $('btnStart');
    btn.disabled = !canStart;
    btn.textContent = filled === 4 ? I18N.T('开始游戏') : I18N.T('开始游戏（需 {a}/4 人）').replace('{a}', filled);

    // v2.0 观战人数
    const sp = room.spectators || [];
    $('roomSpectators').textContent = sp.length
      ? `👁 ${sp.length} 人观战中：${sp.map((s) => s.nickName).join('、')}`
      : '';
  }
  // v7 #16 房间内规则条：把本局开启的规则以彩色标签展示
  function renderRoomRules(room) {
    const el = $('roomRules');
    if (!el || !room || !room.settings) return;
    const s = room.settings;
    const items = [
      { on: s.needExactFinish !== false, t: I18N.T('🎯精确到达') },
      { on: s.allowJump !== false, t: I18N.T('✨同色跳格') },
      { on: s.allowFly !== false, t: I18N.T('🛫飞行箭头') },
      { on: s.allowItems !== false, t: I18N.T('💣道具') },
    ];
    const ts = Number(s.turnSeconds);
    items.push({ on: ts !== 0, t: '⏱' + (ts ? ts + 's' : I18N.T('无倒计时')) });
    if (s.knockout) items.push({ on: true, t: I18N.T('☠️淘汰赛') });
    // v13 自定义规则标签
    if (s.takeoffAny) items.push({ on: true, t: I18N.T('🎲任意起飞') });
    if (s.crashBack === false) items.push({ on: true, t: I18N.T('🕊和平模式') });
    if (s.turbo) items.push({ on: true, t: I18N.T('⚡极速') });
    const rl = Number(s.roundLimit) || 0;
    if (rl > 0) items.push({ on: true, t: I18N.T('🔢上限{n}回合').replace('{n}', rl) });
    el.innerHTML = items.map((it) => `<span class="rr ${it.on ? 'on' : 'off'}">${it.t}</span>`).join('');
  }

  // ===== v13 限时活动中心 =====
  const EV_LABEL = { lottery: I18N.T('🎰 抽奖'), accumulate: I18N.T('📈 累充'), share: I18N.T('📤 分享'), info: I18N.T('📢 公告') };
  async function loadEvents() {
    const card = $('cardEvents'), box = $('eventList');
    if (!card || !box) return;
    try {
      const r = await FlyAPI.events();
      const list = (r && r.events) || [];
      if (!list.length) { card.hidden = true; return; }
      card.hidden = false;
      box.innerHTML = list.map((e) => `<div class="ev-row">`
        + `<span class="ev-tag">${EV_LABEL[e.type] || I18N.T('📢 公告')}</span>`
        + `<span class="ev-main"><b>${escapeHtml(e.title || '')}</b><em>${escapeHtml(e.desc || '')}</em></span>`
        + `<span class="ev-time">${escapeHtml(e.start || '')} ~ ${escapeHtml(e.end || '')}</span>`
        + `</div>`).join('');
    } catch (e) { card.hidden = true; }
  }

  // ===== v13 自定义规则面板（房主专用） =====
  const STYLE_LABEL = { aggressive: I18N.T('激进'), balanced: I18N.T('均衡'), defensive: I18N.T('保守') };
  const STYLE_NEXT = { balanced: 'aggressive', aggressive: 'defensive', defensive: 'balanced' };
  function renderRulesPanel(room) {
    const p = $('rulesPanel');
    if (!p || !room) return;
    const isOwner = room.ownerSeat === state.seat;
    p.hidden = !isOwner;
    if (!isOwner) return;
    const s = room.settings || {};
    const ck = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
    ck('rpTakeoffAny', s.takeoffAny);
    ck('rpCrashBack', s.crashBack !== false);
    ck('rpTurbo', s.turbo);
    ck('rpNeedExact', s.needExactFinish !== false);
    ck('rpItems', s.allowItems !== false);
    ck('rpTeam', s.teamMode);
    ck('rpKnockout', s.knockout);
    const sel = (id, v) => { const el = $(id); if (el) el.value = String(v); };
    sel('rpRoundLimit', Number(s.roundLimit) || 0);
    sel('rpDiceMode', Number(s.diceMode) || 1);
    sel('rpSeries', Number(s.seriesRounds) || 1);
    const locked = room.status === 'playing';
    p.querySelectorAll('input, select').forEach((el) => { el.disabled = locked; });
  }
  function bindRulesPanel() {
    const p = $('rulesPanel');
    if (!p) return;
    const patch = (obj) => {
      if (!currentRoom || !state.roomNo) return;
      FlyAPI.updateSettings(state.roomNo, state.seat, obj)
        .then(() => toast(I18N.T('规则已更新')))
        .catch((e) => toast(I18N.T('规则更新失败：') + (e.message || '')));
    };
    const onCk = (id, key) => { const el = $(id); if (el) el.onchange = () => patch({ [key]: el.checked }); };
    onCk('rpTakeoffAny', 'takeoffAny');
    onCk('rpCrashBack', 'crashBack');
    onCk('rpTurbo', 'turbo');
    onCk('rpNeedExact', 'needExactFinish');
    onCk('rpItems', 'allowItems');
    onCk('rpTeam', 'teamMode');
    onCk('rpKnockout', 'knockout');
    const onSel = (id, key) => { const el = $(id); if (el) el.onchange = () => patch({ [key]: Number(el.value) }); };
    onSel('rpRoundLimit', 'roundLimit');
    onSel('rpDiceMode', 'diceMode');
    onSel('rpSeries', 'seriesRounds');
  }
  $('btnStart').onclick = () => {
    FlyAPI.startGame(state.roomNo, state.seat).catch((e) => toast(I18N.T('开局失败：') + e.message));
  };
  // v7 #18 分享邀请：复制完整邀请链接（含房间号，好友打开即一键填入）
  $('btnShare').onclick = () => {
    if (!currentRoom) { toast(I18N.T('还没有房间号')); return; }
    const link = location.origin + '/?r=' + currentRoom.roomNo;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(() => toast(I18N.T('邀请链接已复制，发给好友即可一起玩')), () => toast(I18N.T('邀请链接：') + link));
    } else toast(I18N.T('邀请链接：') + link);
  };
  $('btnLeaveRoom').onclick = leaveRoom;
  $('btnQuit').onclick = leaveRoom;

  // ================= 对局 =================
  function setupCanvas() {
    const cv = $('board');
    const rect = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const px = Math.max(240, Math.round((rect.width || 320) * dpr));
    if (cv.width !== px) { cv.width = px; cv.height = px; }
  }

  function myColor() {
    return currentRoom && currentRoom.seats[state.seat] ? currentRoom.seats[state.seat].color : 'red';
  }

  // 四色动态边框：跟随视角，自己的颜色永远在正下方并带底部辉光
  function setBoardFrame(viewColor) {
    const wrap = document.querySelector('.board-wrap');
    if (!wrap || !window.Board) return;
    const C = Board.COLORS, T = Board.TILE_HEX || Board.COLOR_HEX;
    const i = Math.max(0, C.indexOf(viewColor));
    const bottom = C[i], left = C[(i + 1) % 4], top = C[(i + 2) % 4], right = C[(i + 3) % 4];
    wrap.style.background =
      `conic-gradient(from -45deg, ${T[top]} 0deg 90deg, ${T[right]} 90deg 180deg, `
      + `${T[bottom]} 180deg 270deg, ${T[left]} 270deg 360deg)`;
    wrap.style.boxShadow =
      `0 22px 55px -12px rgba(93,108,178,.42), 0 0 0 1px rgba(255,255,255,.7), `
      + `inset 0 1px 0 rgba(255,255,255,.6), 0 14px 38px -6px ${T[bottom]}99`;
  }

  function renderGame() {
    const g = currentGame;
    if (!g) return;
    if (replayMode) { renderReplayFrame(g); return; }
    const me = state.seat;
    const isSpec = me < 0; // v2.0 观战者
    const meInfo = isSpec ? null : currentRoom.seats[me];
    const mePlayer = isSpec ? null : g.players.find((p) => p.seat === me);
    if (!isSpec && (!meInfo || !mePlayer)) return;

    // 视角：自己永远转左下（观战者默认红方视角）
    const viewColor = isSpec ? 'red' : meInfo.color;
    Board.setMyView(viewColor);
    setBoardFrame(viewColor);
    setupCanvas();
    const canvas = $('board');
    const cell = canvas.width / Board.GRID;

    // 表情互动条：对局中始终可见（玩家 + 观战者）
    $('emojiBar').hidden = (g.phase === 'ended');

    if (isSpec) {
      // —— 观战只读视图 ——
      $('meColor').style.background = '#6c6c8a';
      $('meText').innerHTML = '👁 ' + I18N.T('你正在 <b>观战</b>');
      $('meProgress').textContent = I18N.T('画面实时同步，不能操作');
      const cur = g.currentSeat;
      const curInfo = currentRoom.seats[cur];
      $('turnInfo').textContent = g.phase === 'ended' ? I18N.T('🏁 对局结束')
        : `⏳ 观战中 · 轮到 ${escapeHtml(curInfo ? curInfo.nickName : '?')} 行动`;
      $('turnInfo').style.borderLeftColor = curInfo ? Board.COLOR_HEX[curInfo.color] : '#6c6c8a';
      $('btnRoll').disabled = true;
      if (diceRolling) stopDiceRoll(diceValues(g)); else renderDice(g);
      $('itemBar').innerHTML = '<span class="it dim">观战模式不持有道具</span>';
      $('btnReroll').hidden = true;
      $('btnHost').hidden = true;
      // 观战横幅 + 接管 AI 座位按钮
      const spList = (currentRoom.spectators || []).map((s) => escapeHtml(s.nickName)).join('、');
      $('spCount').textContent = spList ? `（${spList}）` : '';
      if (g.phase !== 'ended' && currentRoom.status === 'playing') {
        $('spectatorBar').hidden = false;
        const take = $('spTakeover');
        take.innerHTML = '';
        currentRoom.seats.forEach((s) => {
          // 只接管「纯 AI」座位；被真人托管的座位（hosted）不接受接管
          if (s.type === 'ai' && !s.hosted) {
            const b = document.createElement('button');
            b.className = 'sp-btn';
            b.textContent = I18N.T('接管 {c}方({n})').replace('{c}', I18N.T(Board.COLOR_NAME[s.color])).replace('{n}', escapeHtml(s.nickName));
            b.onclick = () => doTakeover(s.seat);
            take.appendChild(b);
          }
        });
      } else {
        $('spectatorBar').hidden = true;
      }
      renderSidePlayers(g);
      animatePlanes(g);
      prev = { currentSeat: g.currentSeat, phase: g.phase, dice: g.dice };
      return;
    }

    // 身份条
    $('meColor').style.background = Board.COLOR_HEX[meInfo.color];
    const onWay = mePlayer.planes.filter((pl) => pl.state !== 'base' && pl.state !== 'home' && pl.state !== 'finished').length;
    $('meText').innerHTML = I18N.T('你是 <b>{c}</b> 方').replace('{c}', I18N.T(Board.COLOR_NAME[meInfo.color]))
      + (meInfo.hosted ? ' <span class="tag-ai">托管中</span>' : '');
    $('meProgress').textContent = `🛬 ${mePlayer.finishedCount}/4 到家　✈ ${onWay} 架在途`;

    // v2.0 手动托管开关：对局中随时把座位交给 AI 代打 / 收回
    const hostable = g.phase !== 'ended' && (meInfo.hosted || meInfo.type === 'human');
    $('btnHost').hidden = !hostable;
    $('btnHost').textContent = meInfo.hosted ? I18N.T('🙋 取消托管') : I18N.T('🤖 托管');

    // 回合指示
    const cur = g.currentSeat;
    const curInfo = currentRoom.seats[cur];
    const myTurn = g.phase !== 'ended' && cur === me && meInfo.type === 'human';
    let info;
    if (g.phase === 'ended') info = I18N.T('🏁 对局结束');
    else if (myTurn && g.phase === 'rolling') info = I18N.T('🎲 轮到你了，点击「掷骰子」（或按空格）');
    else if (myTurn) {
      const n = (g.movablePlanes || []).length;
      // v10 多骰：告诉玩家现在在用第几颗、后面还有几颗
      const total = (g.diceList && g.diceList.length) || 1;
      const prefix = total > 1 ? `🎯 第 ${(Number(g.diceIndex) || 0) + 1}/${total} 颗 · ` : '';
      info = n > 1
        ? `${prefix}👆 点击金色闪烁的飞机（${n} 架可走，可按 1-${n} 键直选）`
        : `${prefix}👆 点击金色闪烁的飞机`;
    } else if (curInfo.type === 'ai') info = `🤖 ${escapeHtml(curInfo.nickName)} 思考中…`;
    else info = `⏳ 等待 ${escapeHtml(curInfo.nickName)} 行动…`;
    $('turnInfo').textContent = info;
    $('turnInfo').style.borderLeftColor = Board.COLOR_HEX[curInfo.color];
    // 轮到我选机：提示条切成琥珀色呼吸态，和棋盘上的金色标记呼应
    $('turnInfo').classList.toggle('is-action', myTurn && g.phase === 'selecting');

    // 骰子
    $('btnRoll').disabled = !(g.phase === 'rolling' && myTurn);
    if (diceRolling) stopDiceRoll(diceValues(g)); else renderDice(g);

    // v3 道具栏：四种道具按钮（有库存且轮到自己时可用）
    renderItemBar(g, me, myTurn);
    $('btnReroll').hidden = true; // 旧重掷卡已废弃，道具统一在道具栏

    // 轮到自己：提示音（防重复：从非我回合进入我的 rolling/selecting）
    if (myTurn && !(prev.currentSeat === me && prev.phase === g.phase)) {
      Sfx.myTurn();
    }

    // 走子动画 + 特效
    renderSidePlayers(g);
    animatePlanes(g);
    syncIdleLoop(); // 兜底：掷完骰子直接进 selecting（无走子动画）时也要起动画循环

    // 跳过提示
    if (g.phase !== 'ended' && prev.currentSeat === me && prev.phase === 'rolling'
      && g.currentSeat !== me && g.phase === 'rolling' && g.dice === 0) {
      toast(I18N.T('本轮无棋可走，已自动跳过'));
      Sfx.skip();
    }
    prev = { currentSeat: g.currentSeat, phase: g.phase, dice: g.dice };
  }

  // 四家进度总览（桌面端右侧栏）
  function renderSidePlayers(g) {
    const box = $('sidePlayers');
    if (!box || !g || !g.players || !currentRoom) return;
    box.innerHTML = g.players.map((p) => {
      if (!p) return '';
      const info = currentRoom.seats[p.seat];
      if (!info) return '';
      const onWay = p.planes.filter((pl) => pl.state !== 'base' && pl.state !== 'home' && pl.state !== 'finished').length;
      const inBase = p.planes.filter((pl) => pl.state === 'base').length;
      const cls = ['sp-row'];
      if (g.currentSeat === p.seat && g.phase !== 'ended') cls.push('is-turn');
      if (p.seat === state.seat) cls.push('is-me');
      const tag = info.hosted ? '<span class="sp-ai">托管</span>'
        : (info.type === 'ai' ? '<span class="sp-ai">AI</span>' : '');
      return `<div class="${cls.join(' ')}">`
        + `<span class="sp-dot" style="background:${Board.COLOR_HEX[p.color]}"></span>`
        + `<span class="sp-nick">${escapeHtml(info.nickName || I18N.T(Board.COLOR_NAME[p.color]))}</span>`
        + badgeHtml(info.badges)
        + tag
        + `<span class="sp-num">🛬${p.finishedCount} ✈${onWay} 🏠${inBase}</span>`
        + '</div>';
    }).join('');
  }

  // v2.0 回放：只读渲染当前帧（复用 animatePlanes 的帧间动画）
  function renderReplayFrame(g) {
    Board.setMyView('red');
    setBoardFrame('red');
    setupCanvas();
    const canvas = $('board');
    const cell = canvas.width / Board.GRID;
    $('meColor').style.background = '#7c5cff';
    $('meText').innerHTML = I18N.T('🎬 回放中');
    $('meProgress').textContent = I18N.T('逐帧回放 · 可暂停 / 调速 / 拖动');
    const cur = g.currentSeat;
    const curInfo = currentRoom.seats[cur];
    $('turnInfo').textContent = g.phase === 'ended' ? I18N.T('🏁 对局结束')
      : `⏳ ${escapeHtml(curInfo ? curInfo.nickName : '?')} 行动`;
    $('turnInfo').style.borderLeftColor = curInfo ? Board.COLOR_HEX[curInfo.color] : '#7c5cff';
    $('btnRoll').disabled = true;
    if (diceRolling) stopDiceRoll(diceValues(g)); else renderDice(g);
    $('itemBar').innerHTML = '<span class="it dim">回放模式</span>';
    $('btnReroll').hidden = true;
    $('btnHost').hidden = true;
    $('spectatorBar').hidden = true;
    $('emojiBar').hidden = true;
    $('replayBar').hidden = false;
    renderSidePlayers(g);
    animatePlanes(g);
  }

  // v2.0 打开回放
  async function openReplay(roomNo) {
    try {
      const res = await FlyAPI.getReplay(roomNo);
      if (!res.ok || !res.replay || !res.replay.frames || !res.replay.frames.length) {
        toast(I18N.T('回放已过期或不存在（云端保留最近 100 局）')); return;
      }
      replay.roomNo = String(roomNo); // v19 供复制回放链接
      if (ws) { try { ws.close(); } catch (e) {} ws = null; } // 回放期间断开实时连接，避免被 state 覆盖
      stopIdleLoop(); // 回放有自己的 tick，别再跑选机动画
      replayMode = true;
      replay.frames = res.replay.frames;
      replay.idx = 0;
      replay.playing = true;
      replay.speed = 1;
      replay.timer = null;
      planeShown = {}; prevSnap = {}; prevItems = null;
      replay.marks = computeReplayBookmarks(replay.frames); // v22 关键时刻书签（帧已就绪）
      renderReplayMarks();
      const first = replay.frames[0];
      currentRoom = first.room; currentGame = first.game;
      switchView('game');
      $('replaySeek').max = String(replay.frames.length - 1);
      $('replaySeek').value = '0';
      $('replayIdx').textContent = '1/' + replay.frames.length;
      setReplaySpeedUI(1);
      $('btnReplayPlay').textContent = I18N.T('⏸ 暂停');
      replayTick();
      toast(I18N.T('回放加载完成，共 {n} 帧').replace('{n}', replay.frames.length));
    } catch (e) { toast(I18N.T('回放加载失败')); }
  }

  // v22 回放书签：扫描帧序列，提取击落/到家/胜负时刻（最近 12 条，终局始终保留）
  function computeReplayBookmarks(frames) {
    const CN = { red: I18N.T('红方'), yellow: I18N.T('黄方'), blue: I18N.T('蓝方'), green: I18N.T('绿方') };
    const kills = [0, 0, 0, 0], homes = [0, 0, 0, 0];
    const marks = [];
    frames.forEach((f, i) => {
      const g = f && f.game;
      if (!g || !Array.isArray(g.players) || i === 0) return;
      g.players.forEach((p) => {
        const seat = p.seat || 0;
        const k = (p.stats && p.stats.kills) || 0;
        const hm = p.finishedCount || 0;
        if (k > kills[seat]) {
          kills[seat] = k;
          marks.push({ i, icon: '💥', text: (CN[g.players[seat].color] || '') + ' ' + I18N.T('第 {n} 次击落').replace('{n}', k) });
        }
        if (hm > homes[seat]) {
          homes[seat] = hm;
          marks.push({ i, icon: '🏠', text: (CN[g.players[seat].color] || '') + ' ' + I18N.T('{n} 机到家').replace('{n}', hm) });
        }
      });
    });
    if (frames.length) marks.push({ i: frames.length - 1, icon: '🏁', text: I18N.T('终局') });
    return marks.slice(-12);
  }
  function renderReplayMarks() {
    const box = $('replayMarks');
    if (!box) return;
    const marks = replay.marks || [];
    if (!marks.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = marks.map((m, idx) =>
      '<button class="rk-btn" data-i="' + m.i + '" title="跳到第 ' + (m.i + 1) + ' 帧">' + m.icon + ' ' + escapeHtml(m.text) + '</button>').join('');
    box.querySelectorAll('.rk-btn').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.i);
        const f = replay.frames[i];
        if (!f) return;
        replay.idx = i;
        replay.playing = false; // 跳转后暂停，方便看清关键帧
        if ($('btnReplayPlay')) $('btnReplayPlay').textContent = I18N.T('▶ 播放');
        if (replay.timer) { clearTimeout(replay.timer); replay.timer = null; }
        currentRoom = f.room; currentGame = f.game;
        renderGame();
        $('replaySeek').value = String(i);
        $('replayIdx').textContent = (i + 1) + '/' + replay.frames.length;
      };
    });
  }
  function replayTick() {
    if (!replayMode) return;
    if (replay.idx >= replay.frames.length) { replay.playing = false; $('btnReplayPlay').textContent = I18N.T('▶ 重播'); return; }
    if (replay.playing) {
      const f = replay.frames[replay.idx];
      currentRoom = f.room; currentGame = f.game;
      renderGame();
      $('replaySeek').value = String(replay.idx);
      $('replayIdx').textContent = (replay.idx + 1) + '/' + replay.frames.length;
      replay.idx += 1;
    }
    const delay = Math.max(220, 700 / replay.speed);
    replay.timer = setTimeout(replayTick, delay);
  }

  function exitReplay() {
    replayMode = false;
    if (replay.timer) { clearTimeout(replay.timer); replay.timer = null; }
    replay.frames = []; replay.idx = 0;
    $('replayBar').hidden = true;
    currentGame = null;
    leaveRoom();
  }

  function setReplaySpeedUI(sp) {
    document.querySelectorAll('.replay-speed').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.speed) === sp);
    });
  }

  // 事件推断：比较新旧快照
  //   prevSnap[key] = { state, rp }（上一帧的服务器状态）；planeShown 只存屏幕坐标
  function detectEvents(g) {
    const cell = $('board').width / Board.GRID;
    const events = [];
    const cur = Board.computePositions(g, cell);
    g.players.forEach((p) => {
      p.planes.forEach((pl) => {
        const key = p.seat + '-' + pl.id;
        const old = prevSnap[key];
        // 起飞：base → rp=0
        if (old && old.state === 'base' && pl.state !== 'base' && pl.rp === 0) {
          events.push({ type: 'takeoff', x: cur[key] ? cur[key].x : 0, y: cur[key] ? cur[key].y : 0 });
        }
        // 到家：非 home → home/finished
        else if (old && old.state !== 'base' && (pl.state === 'home' || pl.state === 'finished') && old.state !== 'home' && old.state !== 'finished') {
          events.push({ type: 'home', x: cur[key] ? cur[key].x : 0, y: cur[key] ? cur[key].y : 0 });
        }
        // v2.0 护盾抵挡：盾消失（只在被撞时消耗）→ 进攻方反震回基地
        else if (old && old.shield && !pl.shield) {
          events.push({ type: 'shield_block', x: cur[key] ? cur[key].x : 0, y: cur[key] ? cur[key].y : 0, seat: p.seat });
        }
        // v2.0 飞行箭头：一步前进 > 6 格（只有飞跃 12 格能做到）
        else if (old && old.state !== 'base' && old.rp >= 0 && pl.rp - old.rp > 6) {
          events.push({ type: 'fly', x: cur[key] ? cur[key].x : 0, y: cur[key] ? cur[key].y : 0, seat: p.seat });
        }
        // 被撞：之前在场（track/main/lane）→ 回 base
        else if (old && old.state !== 'base' && old.state !== 'home' && old.state !== 'finished' && pl.state === 'base') {
          events.push({ type: 'killed', x: cur[key] ? cur[key].x : 0, y: cur[key] ? cur[key].y : 0, seat: p.seat });
        }
      });
    });

    // v3 道具获得/使用：比较每人持卡数变化（bomb 等主动道具通过库存减少来感知）
    if (prevItems && g.items) {
      g.items.forEach((it, seat) => {
        const old = prevItems[seat] || { bomb: 0, shield: 0, accel: 0, swap: 0 };
        ITEM_ORDER.forEach((t) => {
          if (it[t] > (old[t] || 0)) events.push({ type: 'gain_item', seat, item: t });
          else if (it[t] < (old[t] || 0) && seat === state.seat) events.push({ type: 'used_item', seat, item: t });
        });
      });
    }
    prevItems = JSON.parse(JSON.stringify(g.items || []));

    // 生成新快照
    prevSnap = {};
    g.players.forEach((p) => p.planes.forEach((pl) => {
      prevSnap[p.seat + '-' + pl.id] = { state: pl.state, rp: pl.rp, shield: !!pl.shield };
    }));
    return events;
  }

  function playFxFor(events) {
    events.forEach((ev) => {
      if (ev.type === 'move') { Sfx.move(); }
      else if (ev.type === 'takeoff') { Sfx.takeoff(); spawnFx('takeoff', ev.x, ev.y, 600); }
      else if (ev.type === 'home') { Sfx.home(); spawnFx('home', ev.x, ev.y, 800); }
      else if (ev.type === 'killed') {
        if (ev.seat === state.seat) Sfx.killed(); else Sfx.kill();
        spawnFx('kill', ev.x, ev.y, 700);
      }
      // v2.0 飞行箭头
      else if (ev.type === 'fly') {
        Sfx.move();
        if (ev.seat === state.seat) toast(I18N.T('✈ 飞行！沿航线前进 12 格'));
      }
      // v2.0 护盾反震
      else if (ev.type === 'shield_block') {
        Sfx.kill();
        spawnFx('kill', ev.x, ev.y, 700);
        toast(ev.seat === state.seat
          ? I18N.T('🛡 护盾抵挡！对方被反震回基地')
          : I18N.T('🛡 对方护盾抵挡，进攻方被反震回基地'));
      }
      // v3 获得道具
      else if (ev.type === 'gain_item') {
        if (ev.seat === state.seat) {
          Sfx.home();
          const m = ITEM_META[ev.item] || { icon: '🎁', name: I18N.T('道具') };
          toast(I18N.T('🎁 获得{i} {n}卡！{h}').replace('{i}', m.icon).replace('{n}', m.name).replace('{h}', m.hint));
        }
      }
      // v3 使用道具反馈
      else if (ev.type === 'bomb') {
        if (ev.seat === state.seat) toast(I18N.T('💣 炸弹命中！敌方飞机被炸回基地'));
        else if (ev.victimSeat === state.seat) { Sfx.killed(); toast(I18N.T('💥 你的飞机被炸弹炸回基地！')); }
        spawnFx('kill', ev.x, ev.y, 700);
      }
      else if (ev.type === 'use_item' && ev.item === 'shield') {
        if (ev.seat === state.seat) toast(I18N.T('🛡️ 护盾已挂上，本回合撞你不怕'));
      }
      else if (ev.type === 'used_item') {
        const m = ITEM_META[ev.item] || { icon: '🎁', name: I18N.T('道具') };
        toast(I18N.T('🚀 使用了{i} {n}').replace('{i}', m.icon).replace('{n}', m.name));
      }
    });
    // D3 连击提示：同一事件批次内多次击落 → 连击飘字
    const KILL_TYPES = ['killed', 'kill', 'bomb', 'shield_block'];
    const killN = events.filter((e) => KILL_TYPES.indexOf(e.type) >= 0).length;
    if (killN >= 2) {
      spawnEmoji('🔥');
      toast(I18N.T('🔥 连击 x{n}！').replace('{n}', killN));
      Sfx.kill();
    }
  }

  function spawnFx(type, x, y, dur) {
    activeFx = { type, x, y, t0: performance.now(), dur };
    cancelAnimationFrame(fxRAF);
    const loop = (now) => {
      if (!activeFx) return;
      const t = (now - activeFx.t0) / activeFx.dur;
      if (t >= 1) { activeFx = null; return; }
      const g = currentGame;
      if (g) {
        const cv = $('board');
        const cell = cv.width / Board.GRID;
        const ui = { currentSeat: g.currentSeat, phase: g.phase, mySeat: state.seat, movable: g.movablePlanes || [] };
        // 重绘一帧（planeShown 即当前显示位置，保持静止）
        const pos = {}; Object.keys(planeShown).forEach((k) => { if (!k.endsWith('_base')) pos[k] = planeShown[k]; });
        Board.drawScene(cv, g, ui, pos, { ...activeFx, t });
      }
      fxRAF = requestAnimationFrame(loop);
    };
    fxRAF = requestAnimationFrame(loop);
  }

  function animatePlanes(g) {
    const canvas = $('board');
    const cell = canvas.width / Board.GRID;
    const ui = { currentSeat: g.currentSeat, phase: g.phase, mySeat: state.seat, movable: g.movablePlanes || [] };
    const cur = Board.computePositions(g, cell);
    const evs = detectEvents(g);
    const keys = Object.keys(cur);
    const from = {};
    keys.forEach((k) => { from[k] = planeShown[k] || cur[k]; });
    const t0 = performance.now();
    const DUR = ANIM_MS;
    cancelAnimationFrame(animRAF);
    playFxFor(evs);
    function frame(now) {
      const t = Math.min(1, (now - t0) / DUR);
      const e = 1 - Math.pow(1 - t, 3);
      const pos = {};
      keys.forEach((k) => { pos[k] = { x: from[k].x + (cur[k].x - from[k].x) * e, y: from[k].y + (cur[k].y - from[k].y) * e }; });
      Board.drawScene(canvas, g, ui, pos);
      hitboxes = Board.computeHitboxes(g, ui, cell);
      if (t < 1) {
        animRAF = requestAnimationFrame(frame);
      } else {
        keys.forEach((k) => { planeShown[k] = cur[k]; });
        hitboxes = Board.computeHitboxes(g, ui, cell);
        syncIdleLoop(); // 走子落地 → 若接下来要我选机，立刻起动画循环
      }
    }
    animRAF = requestAnimationFrame(frame);
  }

  /* ================= 选机阶段的持续重绘 =================
   * 没有这段，画布只在收到 state 时画一帧，Date.now() 驱动的脉冲/跳动/虚线全是死的
   * —— 这就是「高亮看不出来」的根因。节流到 ~30fps，够顺滑又不烧 CPU。
   */
  let idleRAF = null, idleLast = 0;
  function startIdleLoop() {
    if (idleRAF) return;
    const loop = (now) => {
      idleRAF = requestAnimationFrame(loop);
      if (now - idleLast < IDLE_THROTTLE) return;
      idleLast = now;
      const g = currentGame;
      const ui = g ? {
        currentSeat: g.currentSeat, phase: g.phase,
        mySeat: state.seat, movable: g.movablePlanes || [],
      } : null;
      if (!g || replayMode || !ui) { stopIdleLoop(); return; }
      // v3 道具选目标期间（含 rolling 阶段）也保持循环，否则高亮会闪退
      if (!(usingItem || (g.phase === 'selecting' && g.currentSeat === state.seat))) {
        stopIdleLoop(); return;
      }
      if (!$('view-game').classList.contains('active')) { stopIdleLoop(); return; }
      const cv = $('board');
      const cell = cv.width / Board.GRID;
      const pos = {};
      Object.keys(planeShown).forEach((k) => { if (!k.endsWith('_base')) pos[k] = planeShown[k]; });
      // v3 道具选目标：叠加红环高亮
      if (usingItem) ui.highlight = highlightList();
      Board.drawScene(cv, g, ui, pos);
      hitboxes = Board.computeHitboxes(g, ui, cell);
      if (usingItem) computeTargetHitboxes();
    };
    idleRAF = requestAnimationFrame(loop);
  }
  function stopIdleLoop() {
    if (idleRAF) { cancelAnimationFrame(idleRAF); idleRAF = null; }
  }
  function syncIdleLoop() {
    const g = currentGame;
    const on = !!g && !replayMode && g.phase === 'selecting' && g.currentSeat === state.seat
      && $('view-game').classList.contains('active');
    if (on) startIdleLoop(); else stopIdleLoop();
  }
  // 切到后台就停，回来再判（省电，也避免后台标签页堆积 RAF）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopIdleLoop(); else setTimeout(syncIdleLoop, 60);
  });

  // ================= v3 道具系统 =================
  function isSafeAbs(abs) { return abs === 0 || abs === 13 || abs === 26 || abs === 39; }
  // 当前道具的可选目标
  function eligibleTargets(item) {
    const g = currentGame;
    const me = state.seat;
    const out = [];
    if (!g) return out;
    g.players.forEach((p) => {
      p.planes.forEach((pl) => {
        if (item === 'accel') {
          if (p.seat === me && (pl.state === 'track' || pl.state === 'lane')) out.push({ seat: p.seat, planeId: pl.id });
        } else if (item === 'bomb') {
          if (p.seat !== me && pl.state === 'track') {
            const abs = (Board.COLOR_OFFSET[p.color] + pl.rp) % 52;
            if (!isSafeAbs(abs)) out.push({ seat: p.seat, planeId: pl.id });
          }
        } else if (item === 'swap') {
          if (pl.state === 'track') out.push({ seat: p.seat, planeId: pl.id });
        }
      });
    });
    return out;
  }
  function highlightList() {
    if (!usingItem) return [];
    const elig = eligibleTargets(usingItem.item);
    if (usingItem.item === 'swap' && usingItem.first) {
      return elig.filter((t) => !(t.seat === usingItem.first.seat && t.planeId === usingItem.first.planeId));
    }
    return elig;
  }
  let targetHitboxes = [];
  function computeTargetHitboxes() {
    const cell = ($('board').width) / Board.GRID;
    const r = cell * 0.5;
    targetHitboxes = highlightList().map((t) => {
      const info = planeShown[t.seat + '-' + t.planeId];
      return info ? { seat: t.seat, planeId: t.planeId, x: info.x, y: info.y, r } : null;
    }).filter(Boolean);
  }
  function drawItemTargets() {
    const g = currentGame;
    if (!g || !usingItem) return;
    const cv = $('board');
    const cell = cv.width / Board.GRID;
    const ui = {
      currentSeat: state.seat, phase: g.phase, mySeat: state.seat,
      movable: g.movablePlanes || [], highlight: highlightList(),
    };
    const pos = {}; Object.keys(planeShown).forEach((k) => { if (!k.endsWith('_base')) pos[k] = planeShown[k]; });
    Board.drawScene(cv, g, ui, pos);
    computeTargetHitboxes();
  }
  function renderItemBar(g, me, myTurn) {
    const bar = $('itemBar');
    if (!bar) return;
    const items = (g.items && g.items[me]) || {};
    if (usingItem) {
      const m = ITEM_META[usingItem.item];
      bar.innerHTML = `<span class="it dim">${m.icon} ${m.name}：${m.hint}</span>`
        + `<button class="item-btn cancel" id="btnItemCancel">取消</button>`;
      const cb = $('btnItemCancel'); if (cb) cb.onclick = cancelUsingItem;
      return;
    }
    const canUse = myTurn && g.phase !== 'ended' && g.currentSeat === me && g.allowItems !== false;
    const parts = [];
    ITEM_ORDER.forEach((it) => {
      const n = items[it] || 0;
      if (n > 0) {
        const m = ITEM_META[it];
        parts.push(`<button class="item-btn${canUse ? '' : ' disabled'}" data-item="${it}" ${canUse ? '' : 'disabled'}>${m.icon} ${m.name} ×${n}</button>`);
      }
    });
    if (!parts.length) bar.innerHTML = '<span class="it dim">暂无道具（踩中礼物格可获得）</span>';
    else {
      bar.innerHTML = parts.join('');
      bar.querySelectorAll('.item-btn').forEach((b) => { if (!b.disabled) b.onclick = () => startUsingItem(b.dataset.item); });
    }
  }
  function startUsingItem(item) {
    const g = currentGame;
    if (!g || g.phase === 'ended' || g.currentSeat !== state.seat) return;
    if (item === 'shield') {
      ws && ws.send({ type: 'useItem', payload: { item: 'shield', payload: {} } });
      usingItem = null;
      return;
    }
    usingItem = { item, first: null };
    toast(ITEM_META[item].hint);
    renderItemBar(g, state.seat, true);
    drawItemTargets();
  }
  function cancelUsingItem() {
    usingItem = null;
    if (currentGame) renderGame();
  }
  function onBoardClick(e) {
    const g = currentGame;
    if (!g) return;
    const cv = $('board');
    const rect = cv.getBoundingClientRect();
    const scale = cv.width / rect.width;
    const x = (e.clientX - rect.left) * scale;
    const y = (e.clientY - rect.top) * scale;

    if (usingItem) {
      let hit = null;
      for (const hb of targetHitboxes) {
        if ((x - hb.x) ** 2 + (y - hb.y) ** 2 <= hb.r * hb.r) { hit = hb; break; }
      }
      if (!hit) return;
      const item = usingItem.item;
      if (item === 'swap') {
        if (!usingItem.first) { usingItem.first = { seat: hit.seat, planeId: hit.planeId }; drawItemTargets(); return; }
        if (usingItem.first.seat === hit.seat && usingItem.first.planeId === hit.planeId) return;
        ws && ws.send({ type: 'useItem', payload: { item: 'swap', payload: { targets: [usingItem.first, { seat: hit.seat, planeId: hit.planeId }] } } });
        usingItem = null;
        return;
      }
      ws && ws.send({ type: 'useItem', payload: { item, payload: { target: { seat: hit.seat, planeId: hit.planeId } } } });
      usingItem = null;
      return;
    }

    if (g.phase !== 'selecting' || g.currentSeat !== state.seat) return;
    for (const hb of hitboxes) {
      if ((x - hb.x) ** 2 + (y - hb.y) ** 2 <= hb.r * hb.r) {
        ws && ws.send({ type: 'select', payload: { planeId: hb.planeId } });
        return;
      }
    }
  }
  $('board').addEventListener('click', onBoardClick);

  // 窗口尺寸变化（手机旋转 / 桌面拖窗口）：重排棋盘并重绘
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!currentGame || !$('view-game').classList.contains('active')) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { setupCanvas(); renderGame(); }, 120);
  });

  $('btnRoll').onclick = () => {
    if ($('btnRoll').disabled) return;
    startDiceRoll();
    ws && ws.send({ type: 'roll' });
  };
  // v2.0 重掷卡：选机阶段重掷一次（每回合一次，不计连六）
  // v10：多骰模式下只重掷「当前这一颗」，动画也只摇它
  $('btnReroll').onclick = () => {
    if ($('btnReroll').disabled || $('btnReroll').hidden) return;
    startDiceRoll(currentGame ? (Number(currentGame.diceIndex) || 0) : null);
    ws && ws.send({ type: 'reroll' });
  };
  // v2.0 手动托管：把座位交给 AI 代打 / 收回（服务端会立即调度 AI，不会卡回合）
  $('btnHost').onclick = () => {
    if ($('btnHost').hidden) return;
    const me = state.seat;
    const meInfo = currentRoom && me >= 0 ? currentRoom.seats[me] : null;
    if (!meInfo || currentGame.phase === 'ended') return;
    const on = !meInfo.hosted;
    ws && ws.send({ type: 'host', payload: { on } });
    toast(on ? I18N.T('已交给 AI 托管，随时可点「取消托管」收回') : I18N.T('已收回控制权'));
  };

  // v2.0 表情互动：点表情飘一个气球，服务端限频 3 秒
  let emojiCdUntil = 0;
  $('emojiBar').querySelectorAll('.emoji-btn').forEach((btn) => {
    btn.onclick = () => {
      const now = Date.now();
      if (now < emojiCdUntil) { toast(I18N.T('表情太频繁，稍等')); return; }
      emojiCdUntil = now + 3000;
      const emoji = btn.dataset.emoji;
      ws && ws.send({ type: 'emoji', payload: { emoji } });
      spawnEmoji(emoji);
      // 冷却倒计时提示
      const cd = $('emojiCd'); const t0 = now;
      const tick = setInterval(() => {
        const left = Math.ceil((emojiCdUntil - Date.now()) / 1000);
        if (left <= 0) { clearInterval(tick); cd.textContent = ''; } else cd.textContent = left + 's';
      }, 400);
    };
  });

  // v2.0 观战者接管 AI 座位
  function doTakeover(seat) {
    FlyAPI.takeover(state.roomNo, seat, { clientId: state.clientId, nickName: state.nick || I18N.T('接管者') })
      .then(() => {
        state.seat = seat; state.spectator = false; saveState();
        connectWS(); // 用新座位重连（旧观战连接会随之关闭）
        toast(I18N.T('接管成功，轮到你时即可行动'));
      })
      .catch((e) => toast(I18N.T('接管失败：') + e.message));
  }

  // 飘表情气球
  function spawnEmoji(emoji) {
    const wrap = document.querySelector('.board-wrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'floating-emoji';
    el.textContent = emoji;
    el.style.left = (15 + Math.random() * 70) + '%';
    el.style.fontSize = (28 + Math.random() * 18) + 'px';
    wrap.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2800);
  }

  // v2.0 回放控制条
  $('btnReplayPlay').onclick = () => {
    if (replay.idx >= replay.frames.length) { replay.idx = 0; } // 重播
    replay.playing = !replay.playing;
    $('btnReplayPlay').textContent = replay.playing ? I18N.T('⏸ 暂停') : I18N.T('▶ 播放');
    if (replay.playing) replayTick();
  };
  document.querySelectorAll('.replay-speed').forEach((b) => {
    b.onclick = () => { replay.speed = Number(b.dataset.speed); setReplaySpeedUI(replay.speed); };
  });
  $('replaySeek').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    replay.idx = v;
    const f = replay.frames[v];
    if (f) { currentRoom = f.room; currentGame = f.game; renderGame(); }
    $('replayIdx').textContent = (v + 1) + '/' + replay.frames.length;
  });
  $('btnReplayExit').onclick = exitReplay;

  /* ============ v10 多骰模式：骰子排渲染 ============ */
  const DICE_PIPS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']
    .map((c) => `<span class="p ${c}"></span>`).join('');

  /** 本帧要显示的点数数组（多骰模式下是整组） */
  function diceValues(g) {
    if (g && Array.isArray(g.diceList) && g.diceList.length) return g.diceList.slice();
    return [(g && g.dice) || 0];
  }

  /** 骰子个数变化时重建 DOM（保持尺寸/样式随数量缩放） */
  function syncDiceRow(n) {
    const row = $('diceRow');
    if (!row) return [];
    if (row.dataset.n !== String(n)) {
      row.dataset.n = String(n);
      let html = '';
      for (let i = 0; i < n; i += 1) html += `<div class="dice" data-v="0">${DICE_PIPS}</div>`;
      row.innerHTML = html;
    }
    return Array.prototype.slice.call(row.children);
  }

  /** 静态渲染：已用掉的置灰，当前正在用的那颗描金边 */
  function renderDice(g) {
    const vals = diceValues(g);
    const dice = syncDiceRow(vals.length);
    const idx = (g && Number(g.diceIndex)) || 0;
    const selecting = !!g && g.phase === 'selecting';
    dice.forEach((el, i) => {
      el.setAttribute('data-v', String(vals[i] || 0));
      el.classList.toggle('is-used', selecting && i < idx);
      el.classList.toggle('is-current', selecting && i === idx);
    });
  }

  /**
   * 掷骰动画。onlyIndex 给了就只摇那一颗（重掷卡只重掷当前骰）。
   */
  function startDiceRoll(onlyIndex) {
    if (diceRolling) return;
    diceRolling = true;
    Sfx.dice();
    const dice = syncDiceRow(diceValues(currentGame).length)
      .filter((el, i) => onlyIndex == null || i === onlyIndex);
    dice.forEach((el) => el.classList.add('rolling'));
    diceTimer = setInterval(() => {
      dice.forEach((el) => el.setAttribute('data-v', String(1 + Math.floor(Math.random() * 6))));
    }, 70);
    diceMinUntil = performance.now() + 380;
  }

  function stopDiceRoll(list) {
    const vals = Array.isArray(list) ? list : [list];
    const wait = Math.max(0, diceMinUntil - performance.now());
    setTimeout(() => {
      const dice = syncDiceRow(vals.length);
      const finish = () => {
        dice.forEach((el, i) => {
          el.classList.remove('rolling');
          el.setAttribute('data-v', String(vals[i] || 0));
        });
      };
      if (!diceRolling) { finish(); return; }
      clearInterval(diceTimer);
      diceRolling = false;
      finish();
      Sfx.diceResult(vals[0] || 0);
    }, wait);
  }

  // v7 统一发消息入口（输入框 / 快捷短语共用）
  function sendChat(text) {
    const v = String(text || '').trim();
    if (!v) return;
    ws && ws.send({ type: 'chat', payload: { text: v } });
  }
  $('btnSend').onclick = () => {
    const t = $('chatText'); const v = t.value.trim(); if (!v) return;
    sendChat(v);
    t.value = '';
  };
  $('chatText').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnSend').click(); });
  // v7 快捷短语：点一下直接发，省得手机上打字
  document.querySelectorAll('#quickChat .qc').forEach((b) => {
    b.onclick = () => sendChat(b.textContent);
  });
  // v7 键盘快捷键：空格 = 掷骰子（输入框内不拦截）
  document.addEventListener('keydown', (e) => {
    if (replayMode) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (!$('view-game').classList.contains('active')) return;
    if (e.code === 'Space' || e.key === ' ') {
      const btn = $('btnRoll');
      if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
      return;
    }
    // v10 数字键 1-4 直选可走飞机（编号 = 棋盘上的金色徽章，与 hitboxes 顺序一致）
    if (e.key >= '1' && e.key <= '9') {
      const g = currentGame;
      if (!g || g.phase !== 'selecting' || g.currentSeat !== state.seat) return;
      const hb = hitboxes[Number(e.key) - 1];
      if (hb) {
        e.preventDefault();
        ws && ws.send({ type: 'select', payload: { planeId: hb.planeId } });
      }
    }
  });
  function addChat(d) {
    const c = $('chat');
    const row = document.createElement('div');
    if (d.seat === undefined) { row.className = 'c-row c-sys'; row.textContent = d.text; }
    else {
      row.className = 'c-row';
      row.innerHTML = `<span class="c-name">${escapeHtml(d.nick || I18N.T('玩家'))}${I18N.T('：')}</span>${escapeHtml(d.text)}`;
      // v12 举报入口：别人发的消息才给按钮（长按/悬停出现，不占版面）
      const nick = String(d.nick || '').replace(/\(托管\)$/, '').trim();
      if (nick && nick !== state.nick && d.seat !== state.seat) {
        const rp = document.createElement('button');
        rp.className = 'c-report'; rp.title = I18N.T('举报这条发言'); rp.textContent = '⚠';
        rp.onclick = () => doReport(nick);
        row.appendChild(rp);
      }
    }
    c.appendChild(row); c.scrollTop = c.scrollHeight;
  }

  // 对局结束：完整排名弹窗 + 音效 + 海报
  function showWin(d) {
    loadMailBadge(); // v18 新战报红点
    lastGameover = d;
    const teamMode = !!d.teamMode;
    const winner = d.order ? d.order[0] : { nick: '?', color: 'red' };
    if (winner.isWinner || winner.seat === state.seat) Sfx.win(); else Sfx.lose();
    const b = document.createElement('div');
    b.className = 'win-banner';
    const rows = (d.order || []).map((p, i) => `
      <div class="w-row">
        <span class="w-rank">${['🥇', '🥈', '🥉', '4'][i] || i + 1}</span>
        <span class="w-dot" style="background:${teamMode ? Board.COLOR_HEX[p.team === 1 ? 'blue' : 'red'] : Board.COLOR_HEX[p.color]}"></span>
        <span class="w-nick">${teamMode ? `<em class="w-team">${p.team === 1 ? I18N.T('蓝队') : I18N.T('红队')}</em>` : ''}${escapeHtml(p.nick)}${p.seat === state.seat ? I18N.T('（你）') : ''}</span>
        <span class="w-fin">🛬${p.finishedCount}</span>
        <span class="w-kill">💥${p.kills}</span>
        <span class="w-killed">🩸${p.beenKilled}</span>
        <span class="w-six">🎲${p.sixes || 0}</span>
        ${(!teamMode && p.seat !== state.seat && currentRoom && currentRoom.seats[p.seat] && currentRoom.seats[p.seat].type === 'human')
          ? '<span class="w-social" data-nick="' + escapeHtml(p.nick) + '"></span>' : ''}
      </div>`).join('');
    // v7 成就解锁：结算后服务端把新解锁的成就按昵称塞进 game_over
    const ACH_ICON = { first_win: '🥇', streak_3: '🔥', streak_5: '⚡', veteran: '🏅', centurion: '🎖️', ace: '🎯', six_king: '🎲', flawless: '💎', comeback: '💪', master_slayer: '⚔️' };
    const ACH_NAME = { first_win: I18N.T('首胜'), streak_3: I18N.T('三连胜'), streak_5: I18N.T('五连霸'), veteran: I18N.T('常胜将军'), centurion: I18N.T('百战沙场'), ace: I18N.T('王牌杀手'), six_king: I18N.T('六点狂魔'), flawless: I18N.T('完美胜利'), comeback: I18N.T('绝地反击'), master_slayer: I18N.T('大师克星') };
    const myRow = (d.order || []).find((p) => p.seat === state.seat);
    const isOwner = !!(currentRoom && currentRoom.ownerSeat === state.seat);
    const myFresh = (d.achievements && myRow && d.achievements[String(myRow.nick).replace(/\(托管\)$/, '').trim()]) || [];
    const achHtml = myFresh.length
      ? `<div class="w-ach"><div class="wa-t">🎉 解锁 ${myFresh.length} 个新成就</div>${
        myFresh.map((id) => `<span class="wa-chip"><i>${ACH_ICON[id] || '🏆'}</i>${ACH_NAME[id] || id}</span>`).join('')
      }</div>`
      : '';

    const winColor = teamMode ? Board.COLOR_HEX[d.winnerTeam === 1 ? 'blue' : 'red'] : Board.COLOR_HEX[winner.color];

    // v11 系列赛积分榜：多局累计，终局时加冕总冠军
    const seriesActive = !!(d.series && d.series.active);
    const seriesFinal = seriesActive && d.series.final;
    let seriesHtml = '';
    if (seriesActive) {
      const sc = d.series.scores || [];
      const champSeat = d.series.champion;
      const rowsS = sc.map((p, i) => `
        <div class="w-row ${p.seat === champSeat ? 'w-champ' : ''}">
          <span class="w-rank">${['🥇', '🥈', '🥉', '4'][i] || i + 1}</span>
          <span class="w-dot" style="background:${Board.COLOR_HEX[p.color]}"></span>
          <span class="w-nick">${p.seat === champSeat ? '👑 ' : ''}${escapeHtml(p.nick)}${p.seat === state.seat ? I18N.T('（你）') : ''}</span>
          <span class="w-fin">⭐${p.points}</span>
          <span class="w-kill">🏆${p.wins}</span>
          <span class="w-killed">🛬${p.homes}</span>
        </div>`).join('');
      const head = seriesFinal
        ? `<div class="w-series-t">🏆 系列赛总冠军：${escapeHtml((sc[0] && sc[0].nick) || '')}<em>${d.series.current}/${d.series.rounds} 局</em></div>`
        : `<div class="w-series-t">系列赛 第 ${d.series.current}/${d.series.rounds} 局结束 · 累计积分</div>`;
      seriesHtml = `<div class="w-series">${head}<div class="w-list">${rowsS}</div></div>`;
    }

    // v12 PVE 闯关结算条：通关发币 / 失败给个再战提示
    let pveHtml = '';
    if (d.pve && d.pve.on) {
      pveHtml = d.pve.cleared && !d.pve.repeat
        ? `<div class="w-pve ok">🎯 第 ${d.pve.level} 关「${escapeHtml(d.pve.name || '')}」通关！+🪙${d.pve.gained} 金币</div>`
        : (d.pve.cleared
          ? `<div class="w-pve ok">🎯 重复挑战成功（金币只在首次通关发放）</div>`
          : `<div class="w-pve no">💥 第 ${d.pve.level} 关挑战失败，再来一次！</div>`);
    }

    // v12 淘汰赛播报：本局末名出局
    let koHtml = '';
    if (d.knockout && d.knockout.on && d.knockout.out !== null && d.knockout.out !== undefined) {
      koHtml = `<div class="w-ko">☠️ ' + I18N.T('淘汰赛：') + '<b>' + escapeHtml(d.knockout.nick || I18N.T('座位{n}').replace('{n}', d.knockout.out)) + '</b>' + I18N.T(' 本局末名被淘汰，剩 {n} 人').replace('{n}', d.knockout.alive) + (d.knockout.out === state.seat ? I18N.T('（你被淘汰了，可继续观战）') : '') + '</div>`;
    }

    // 重开/下一局按钮：系列赛终局不再提供；非终局系列赛房主点「下一局」
    let rematchHtml;
    if (seriesActive && seriesFinal) {
      rematchHtml = '';
    } else if (isOwner) {
      rematchHtml = seriesActive
        ? `<button class="primary" id="btnRematch"><svg style="width:16px;height:16px"><use href="#i-refresh"/></svg>${I18N.T('下一局 ▶')}</button>`
        : `<button class="primary" id="btnRematch"><svg style="width:16px;height:16px"><use href="#i-refresh"/></svg>${I18N.T('再来一局')}</button>`;
    } else {
      rematchHtml = seriesActive ? `<span class="w-wait">⏳ ${I18N.T('等待房主开始下一局…')}</span>` : `<span class="w-wait">⏳ ${I18N.T('等待房主再来一局…')}</span>`;
    }

    b.innerHTML = `<div class="w-title" style="color:${winColor}">🏆 ${teamMode ? escapeHtml(d.winnerName) + I18N.T(' 获胜！') : escapeHtml(winner.nick) + I18N.T(' 获胜！')}</div>`
      + `<div class="w-list">${rows}</div>`
      + pveHtml
      + achHtml
      + koHtml
      + seriesHtml
      + `<div class="w-btns">`
      + rematchHtml
      + `<button class="primary" id="btnReplay">${I18N.T('看回放')}</button><button class="primary" id="btnPoster">${I18N.T('生成分享海报')}</button><button class="ghost" id="btnBackLobby">${I18N.T('返回大厅')}</button></div>`;
    document.body.appendChild(b);
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
            if (r.ok) btn.outerHTML = '<span class="w-friend-tag">✓ ' + I18N.T('已加') + '</span>';
            else toast(I18N.T('添加失败：') + (r.error || ''));
          } catch (e) { toast(I18N.T('添加失败')); }
        };
      });
      b.querySelectorAll('.w-stat-btn').forEach((btn) => {
        btn.onclick = () => {
          $('lbNick').value = btn.dataset.nick;
          $('modal-lb').classList.add('show');
          queryPlayerStats(btn.dataset.nick);
        };
      });
    })();
    if (myFresh.length) Sfx.takeoff();
    if (d.pve && d.pve.cleared && d.pve.coins !== undefined) updateCoin(d.pve.coins); // 通关奖励即时上顶栏
    if (isOwner && $('btnRematch')) $('btnRematch').onclick = () => { if (b.parentNode) b.parentNode.removeChild(b); doRematch(); };
    $('btnBackLobby').onclick = () => { if (b.parentNode) b.parentNode.removeChild(b); leaveRoom(); };
    // 作用域绑定：结算弹窗的 btnPoster 与福利中心弹窗 id 相同，必须用 b.querySelector 避免抢绑
    const rpBtn = b.querySelector('#btnPoster'); if (rpBtn) rpBtn.onclick = () => makePoster(d);
    $('btnReplay').onclick = () => { if (b.parentNode) b.parentNode.removeChild(b); openReplay(state.roomNo); };
  }

  // v9 再来一局：房主点一下 → 服务端重置并直接重开（座位/昵称都还在）
  async function doRematch() {
    try {
      const res = await FlyAPI.restartRoom(state.roomNo, state.seat);
      if (!res.ok) toast(I18N.T('再来一局失败：') + (res.error || ''));
    } catch (e) { toast(I18N.T('再来一局失败')); }
  }

  // v9 回合倒计时：本地按绝对截止时间戳平滑倒数，避免依赖服务端逐帧推送而跳变
  function updateTurnTimer() {
    const el = $('turnTimer'); if (!el) return;
    const g = currentGame;
    if (!g || g.phase === 'ended' || !currentRoom) { el.classList.remove('show'); return; }
    const seat = currentRoom.seats[g.currentSeat];
    const deadline = g.turnDeadline || 0;
    const remaining = deadline ? Math.max(0, deadline - Date.now()) : 0;
    if (!seat || seat.type !== 'human' || remaining <= 0
      || (g.phase !== 'rolling' && g.phase !== 'selecting')) {
      el.classList.remove('show'); return;
    }
    el.classList.add('show');
    const total = (currentRoom.settings && currentRoom.settings.turnSeconds > 0
      ? currentRoom.settings.turnSeconds : 30) * 1000;
    const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
    const bar = el.querySelector('.tt-bar > i'); if (bar) bar.style.width = pct + '%';
    const num = el.querySelector('.tt-num'); if (num) num.textContent = '⏱ ' + Math.ceil(remaining / 1000) + 's';
    el.classList.toggle('urgent', remaining <= 5000);
  }

  // v9 服务器在线统计：顶栏展示当前在线房间/玩家/观战
  async function loadServerStats() {
    try {
      const res = await FlyAPI.serverStats();
      if (res.ok && res.stats) {
        const s = res.stats;
        const el = $('serverStat');
        if (el) el.textContent = `🟢 ${s.rooms}房 · ${s.players}人在线 · ${s.spectators}观战`;
      }
    } catch (e) { /* 离线时静默 */ }
  }

  // ================= 分享海报（Canvas 合成 + 长按保存） =================
  function makePoster(d) {
    const W = 600, H = 900;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    // 背景 + 光斑
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#1f1f3a'); grad.addColorStop(1, '#12121f');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    [[110, 130, 200, 'rgba(124,92,255,0.20)'], [500, 720, 220, 'rgba(0,180,230,0.16)']].forEach((b) => {
      const rg = ctx.createRadialGradient(b[0], b[1], 0, b[0], b[1], b[2]);
      rg.addColorStop(0, b[3]); rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    });
    // 标题
    ctx.fillStyle = '#fff'; ctx.font = 'bold 40px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(I18N.T('✈ 飞行棋 · 对局战报'), W / 2, 82);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = '15px sans-serif';
    ctx.fillText(new Date().toLocaleString('zh-CN', { hour12: false }), W / 2, 112);

    const teamMode = !!d.teamMode;
    const winner = d.order[0];
    ctx.fillStyle = teamMode ? Board.COLOR_HEX[d.winnerTeam === 1 ? 'blue' : 'red'] : Board.COLOR_HEX[winner.color];
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText(teamMode ? '🏆 ' + (d.winnerTeam === 1 ? I18N.T('蓝队') : I18N.T('红队')) + I18N.T(' 获胜') : '🏆 ' + winner.nick + I18N.T(' 获胜'), W / 2, 168);

    // 排名列表
    ctx.font = '22px sans-serif';
    (d.order || []).forEach((p, i) => {
      const y = 244 + i * 58;
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      roundRect(ctx, 60, y - 26, 480, 44, 10); ctx.fill();
      ctx.textAlign = 'left';
      ctx.fillStyle = ['#ffd700', '#c0c0c0', '#cd7f32', '#888'][i] || '#888';
      ctx.fillText(['①', '②', '③', '④'][i] || String(i + 1), 78, y + 4);
      ctx.fillStyle = Board.COLOR_HEX[p.color];
      ctx.beginPath(); ctx.arc(128, y - 4, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      const nk = p.nick + (p.seat === state.seat ? I18N.T('（我）') : '');
      ctx.fillText(nk.length > 9 ? nk.slice(0, 9) + '…' : nk, 150, y + 4);
      ctx.fillStyle = '#9a9ab0'; ctx.font = '18px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`🛬${p.finishedCount} 💥${p.kills}`, 522, y + 4);
      ctx.font = '22px sans-serif';
    });

    // 二维码：扫码直达房间（有房号带上，否则首页）
    const url = location.origin + (state.roomNo ? '/?r=' + state.roomNo : '/');
    const qrY = 500;
    let qrBox = 0;
    try {
      const px = 5;
      const probe = QR.make(url);
      qrBox = (probe.size + 4) * px;
      const qx = (W - qrBox) / 2;
      ctx.fillStyle = '#fff';
      roundRect(ctx, qx - 8, qrY - 8, qrBox + 16, qrBox + 16, 12); ctx.fill();
      QR.draw(ctx, url, qx, qrY, px, '#12121f', '#ffffff');
    } catch (e) { qrBox = 0; }

    ctx.textAlign = 'center';
    const ty = qrY + (qrBox || 0) + 52;
    ctx.fillStyle = '#8f7cff'; ctx.font = 'bold 26px sans-serif';
    ctx.fillText(state.roomNo ? I18N.T('扫码进房 {n}').replace('{n}', state.roomNo) : I18N.T('扫码来和我对战！'), W / 2, ty);
    ctx.fillStyle = '#e8e8f0'; ctx.font = '17px monospace';
    ctx.fillText(url.replace(/^https?:\/\//, ''), W / 2, ty + 34);
    ctx.fillStyle = '#5a5a72'; ctx.font = '14px sans-serif';
    ctx.fillText(I18N.T('长按保存图片 · 微信扫一扫即可开局'), W / 2, ty + 64);

    // 弹窗展示 + 保存
    const dataUrl = cv.toDataURL('image/png');
    const modal = document.createElement('div');
    modal.className = 'poster-modal';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = I18N.T('战报海报');
    const tip = document.createElement('div');
    tip.className = 'poster-tip';
    tip.textContent = I18N.T('长按图片保存，或点下方按钮下载');
    const acts = document.createElement('div');
    acts.className = 'poster-acts';
    const dl = document.createElement('a');
    dl.className = 'primary small';
    dl.textContent = I18N.T('⬇ 保存图片');
    dl.href = dataUrl;
    dl.download = `飞行棋战报_${Date.now()}.png`;
    const cp = document.createElement('button');
    cp.className = 'ghost small';
    cp.textContent = I18N.T('🔗 复制链接');
    cp.onclick = () => copyText(url);
    const close = document.createElement('button');
    close.className = 'ghost small';
    close.textContent = I18N.T('关闭');
    close.onclick = () => document.body.removeChild(modal);
    acts.appendChild(dl); acts.appendChild(cp); acts.appendChild(close);
    modal.appendChild(img); modal.appendChild(tip); modal.appendChild(acts);
    document.body.appendChild(modal);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ================= 天梯匹配（#17） =================
  let matchWs = null;
  let matchHintTimer = null;
  let matchTierName = I18N.T('青铜');
  function _matchNick() { return (($('joinNick').value || $('createNick').value || '').trim()) || state.nick || I18N.T('玩家'); }
  function openMatchOverlay() { const o = $('matchOverlay'); if (o) o.classList.add('show'); }
  function closeMatchOverlay() { const o = $('matchOverlay'); if (o) o.classList.remove('show'); }
  function setMatchSub(t) { const e = $('matchSub'); if (e) e.textContent = t; }
  function setMatchMeta(t) { const e = $('matchMeta'); if (e) e.textContent = t; }

  async function startMatch() {
    const nick = _matchNick();
    state.nick = nick; saveState();
    // 拉自身段位用于展示（失败则用青铜兜底）
    try {
      const ps = await FlyAPI.statsPlayer(nick);
      if (ps && ps.player && ps.player.tierName) matchTierName = (ps.player.tierIcon || '') + ps.player.tierName;
    } catch (e) { /* ignore */ }
    setMatchMeta(I18N.T('段位：') + matchTierName + I18N.T(' · 匹配人数：') + 1);
    setMatchSub(I18N.T('已加入匹配队列，正在寻找对手…'));
    openMatchOverlay();
    clearTimeout(matchHintTimer); // v42 匹配兜底：25 秒无人提示可玩人机
    matchHintTimer = setTimeout(() => {
      if (matchWs && matchWs.readyState === 1) setMatchSub(I18N.T('暂时没等到对手，可以先「取消匹配」去玩人机，或继续等待'));
    }, 25000);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = `roomNo=__lobby__&clientId=${encodeURIComponent(state.clientId)}&nick=${encodeURIComponent(nick)}`;
    let ws;
    try { ws = new WebSocket(`${proto}://${location.host}/ws?${q}`); }
    catch (e) { clearTimeout(matchHintTimer); toast(I18N.T('匹配连接失败')); closeMatchOverlay(); return; }
    matchWs = ws;
    ws.onopen = () => { try { ws.send(JSON.stringify({ type: 'match' })); } catch (e) {} };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'lobby') {
        if (msg.data && msg.data.count != null) setMatchMeta(I18N.T('段位：') + matchTierName + I18N.T(' · 匹配人数：') + msg.data.count);
        if (msg.data && msg.data.joined) setMatchSub(I18N.T('已加入匹配队列，正在寻找对手…'));
      } else if (msg.type === 'matched') {
        onMatched(msg.data);
      }
      // pong / heartbeat 忽略
    };
    ws.onclose = () => { if (matchWs === ws) matchWs = null; };
    ws.onerror = () => { toast(I18N.T('匹配连接异常，请重试')); };
  }

  function onMatched(d) {
    if (!d || !d.roomNo) return;
    clearTimeout(matchHintTimer);
    if (matchWs) { try { matchWs.close(); } catch (e) {} matchWs = null; }
    closeMatchOverlay();
    const colorName = [I18N.T('红'), I18N.T('黄'), I18N.T('蓝'), I18N.T('绿')][Number(d.seat)] || d.seat;
    state.clientId = d.clientId;
    state.nick = d.nick || state.nick;
    state.roomNo = d.roomNo;
    state.seat = Number(d.seat);
    state.spectator = false;
    saveState();
    FlyAPI.getRoom(d.roomNo).then((r) => {
      currentRoom = r.room;
      switchView('game'); planeShown = {}; prevSnap = {};
      connectWS();
      toast(I18N.T('匹配成功！房间 {n}，你是{c}方').replace('{n}', d.roomNo).replace('{c}', colorName));
    }).catch(() => {
      switchView('room'); connectWS();
    });
  }

  function cancelMatch() {
    clearTimeout(matchHintTimer);
    if (matchWs) {
      try { matchWs.send(JSON.stringify({ type: 'cancelMatch' })); } catch (e) {}
      try { matchWs.close(); } catch (e) {}
      matchWs = null;
    }
    closeMatchOverlay();
    toast(I18N.T('已取消匹配'));
  }

  if ($('btnMatch')) $('btnMatch').onclick = startMatch;
  if ($('btnMatchCancel')) $('btnMatchCancel').onclick = cancelMatch;

  // ================= 好友通知 WS（常驻，不进匹配池） =================
  function connectNotify() {
    if (!state.nick) return;
    if (notifyWs && notifyWs.readyState < 2) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = `roomNo=__notify__&clientId=${encodeURIComponent(state.clientId)}&nick=${encodeURIComponent(state.nick)}`;
    try { notifyWs = new WebSocket(`${proto}://${location.host}/ws?${q}`); }
    catch (e) { notifyWs = null; return; }
    notifyWs.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'invite') showInvite(msg.data);
      else if (msg.type === 'friend_online') toast(I18N.T('🟢 好友「') + escapeHtml((msg.data && msg.data.nick) || '') + I18N.T('」上线了')); // v30/v36
      else if (msg.type === 'pong' && msg.data && msg.data.v) checkVersionMatch(msg.data.v); // v39 版本漂移检测
    };
    notifyWs.onclose = () => { notifyWs = null; setTimeout(connectNotify, 3000); };
    notifyWs.onerror = () => { try { notifyWs.close(); } catch (e) {} };
  }

  // ================= WebSocket =================
  function connectWS() {
    if (ws) ws.close();
    ws = new GameSocket({
      roomNo: state.roomNo, seat: state.seat, clientId: state.clientId,
      handlers: {
        onOpen: () => { setConn(true); hideReconnect(); },
        onClose: () => { setConn(false); if (currentRoom && currentRoom.status === 'playing') showReconnect(); },
        onRetry: (n) => { // v38 心跳/退避：把第 N 次重试反馈到遮罩上
          const t = document.querySelector('#reconnectMask .rm-title');
          if (t && n > 1) t.textContent = I18N.T('正在第 {n} 次尝试重连…').replace('{n}', n);
        },
        onStale: (remote) => checkVersionMatch(remote), // v39 版本漂移检测
        onState: (d) => {
          // v9 再来一局：若胜利弹窗还开着、服务端已重开新局，先关掉它
          const wb = document.querySelector('.win-banner');
          if (wb && d.room && d.room.status === 'playing' && d.game) {
            if (wb.parentNode) wb.parentNode.removeChild(wb);
          }
          currentRoom = d.room; currentGame = d.game;
          updateTurnTimer();
          if (d.room && d.room.status === 'playing' && d.game) {
            if (!$('view-game').classList.contains('active')) {
              switchView('game');
              planeShown = {}; // 进入对局时重置动画基准
              prevSnap = {};   // 重置事件快照，避免恢复时误报特效
            }
            renderGame();
          } else {
            if (!$('view-room').classList.contains('active')) switchView('room');
            renderRoom(d.room);
          }
        },
        onChat: (d) => addChat(d),
        onEmoji: (d) => { if (d && d.seat !== state.seat) spawnEmoji(d.emoji); },
        onGameOver: (d) => showWin(d),
        onInvite: (d) => showInvite(d),
        onError: (d) => toast(I18N.T('错误：') + ((d && d.error) || I18N.T('未知'))),
      },
    });
  }
  function leaveRoom() {
    if (ws) { try { ws.send({ type: 'leave' }); } catch (e) {} ws.close(); }
    cancelAnimationFrame(animRAF); cancelAnimationFrame(fxRAF); stopIdleLoop();
    planeShown = {}; activeFx = null;
    state.roomNo = undefined; saveState();
    currentRoom = null; currentGame = null;
    switchView('lobby');
    toast(I18N.T('已离开房间'));
  }

  // ================= 设置开关 =================
  function syncToggles() {
    $('tglSfx').classList.toggle('on', !!state.sfxOn);
    $('tglVib').classList.toggle('on', !!state.vibOn);
  }
  $('tglSfx').onclick = () => { state.sfxOn = !state.sfxOn; Sfx.setEnabled(state.sfxOn); saveState(); syncToggles(); Sfx.myTurn(); };
  $('tglVib').onclick = () => { state.vibOn = !state.vibOn; Sfx.setVibration(state.vibOn); saveState(); syncToggles(); };
  syncToggles();

  // ================= v9 设置面板 =================
  function syncSettingsUI() {
    $('stSfx').classList.toggle('on', !!state.sfxOn);
    $('stBgm').classList.toggle('on', !!state.bgmOn);
    $('stVib').classList.toggle('on', !!state.vibOn);
    $('stAnim').value = String(state.animMs || 380);
    $('stTheme').value = state.theme || 'classic';
  }
  $('btnSettings').onclick = () => { syncSettingsUI(); $('modal-settings').classList.add('show'); };
  $('btnSettingsClose').onclick = () => $('modal-settings').classList.remove('show');
  $('stSfx').onclick = () => { state.sfxOn = !state.sfxOn; Sfx.setEnabled(state.sfxOn); saveState(); syncSettingsUI(); };
  $('stBgm').onclick = () => { state.bgmOn = !state.bgmOn; Sfx.setBgm(state.bgmOn); saveState(); syncSettingsUI(); };
  $('stVib').onclick = () => { state.vibOn = !state.vibOn; Sfx.setVibration(state.vibOn); saveState(); syncSettingsUI(); };
  $('stAnim').onchange = () => { state.animMs = Number($('stAnim').value); ANIM_MS = state.animMs; saveState(); };
  $('stTheme').onchange = () => { state.theme = $('stTheme').value; applySkin(state.theme); saveState(); };
  // v15 账号凭证展示与复制（换设备迁移用）
  if ($('stSecret')) $('stSecret').textContent = state.secret || '';
  if ($('btnCopySecret')) $('btnCopySecret').onclick = () => { copyText(state.secret || ''); toast(I18N.T('凭证已复制，请妥善保存')); };

  // ================= v9 好友系统 =================
  function copyText(t) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t); return; } } catch (e) {}
    try {
      const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    } catch (e) {}
  }
  async function loadFriends() {
    if (!state.nick) { $('mfMy').textContent = I18N.T('未设置'); renderFriends([]); return; }
    $('mfMy').textContent = state.nick;
    try {
      const res = await fetch('/api/friend/list?nick=' + encodeURIComponent(state.nick)).then((x) => x.json());
      renderFriends(res.friends || []);
    } catch (e) { renderFriends([]); }
  }
  function renderFriends(list) {
    const el = $('mfList'); el.innerHTML = '';
    if (!list.length) { el.innerHTML = '<p class="tip">' + I18N.T('还没有好友，输入昵称加一个吧。') + '</p>'; return; }
    list.forEach((f) => {
      // v13 后端返回 [{nick, online}]，兼容旧的纯字符串数组
      const nick = (typeof f === 'string') ? f : String((f && f.nick) || '');
      const online = (f && typeof f === 'object') ? !!f.online : false;
      const row = document.createElement('div'); row.className = 'mf-item';
      const name = document.createElement('span'); name.className = 'mf-name';
      name.innerHTML = `<i class="mf-dot ${online ? 'on' : ''}" title="${online ? I18N.T('在线') : I18N.T('离线')}"></i>${escapeHtml(nick)}`;
      row.appendChild(name);
      row.appendChild(mkBtn(I18N.T('邀战'), () => doInviteFriend(nick)));
      row.appendChild(mkBtn(I18N.T('赠币'), () => doGiftCoins(nick), 'ghost sm'));
      row.appendChild(mkBtn(I18N.T('删除'), () => doRemoveFriend(nick), 'ghost sm'));
      el.appendChild(row);
    });
  }
  // v13 好友赠币（服务端带每日限额）
  async function doGiftCoins(who) {
    if (!state.nick) { toast(I18N.T('请先设置昵称')); return; }
    const s = window.prompt(I18N.T('赠送金币给「{n}」\n单次最多 1000，每日限额 200：').replace('{n}', who), '10');
    if (s === null) return;
    const n = Math.floor(Number(s));
    if (!(n > 0)) { toast(I18N.T('请输入正确的金币数')); return; }
    try {
      const r = await FlyAPI.transferCoins(state.nick, who, n);
      if (r.ok) { toast(I18N.T('已赠送 {n} 金币给 {w}').replace('{n}', n).replace('{w}', who)); updateCoin(r.fromCoins); }
      else if (r.error === 'DAILY_LIMIT') toast(I18N.T('今日转账已达上限，还能转 {n} 金币').replace('{n}', r.left || 0));
      else if (r.error === 'AUTH_FAILED' || r.error === 'AUTH_REQUIRED') toast(I18N.T('账号凭证校验失败，请在设置里复制凭证并联系管理员重置'));
      else toast(I18N.T('赠送失败：') + (r.error || ''));
    } catch (e) { toast(I18N.T('赠送失败：') + (e.message || '')); }
  }
  async function doAddFriend() {
    const f = ($('mfInput').value || '').trim();
    if (!f) return;
    if (!state.nick) { toast(I18N.T('请先在大厅设置昵称')); return; }
    try {
      const res = await jpost('/api/friend/add', { nick: state.nick, friend: f });
      if (res.ok) { $('mfInput').value = ''; loadFriends(); toast(I18N.T('已添加 {n}').replace('{n}', f)); }
      else if (res.error === 'AUTH_FAILED' || res.error === 'AUTH_REQUIRED') toast(I18N.T('账号凭证校验失败'));
      else toast(I18N.T('添加失败：') + (res.error || ''));
    } catch (e) { toast(I18N.T('添加失败')); }
  }
  async function doRemoveFriend(f) {
    try {
      await fetch('/api/friend/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nick: state.nick, friend: f }) }).then((x) => x.json());
      loadFriends();
    } catch (e) { /* ignore */ }
  }
  async function doInviteFriend(f) {
    if (!state.nick) { toast(I18N.T('请先设置昵称')); return; }
    try {
      const res = await createAndEnter();
      const no = res.roomNo;
      const link = location.origin + '/?r=' + no;
      copyText(I18N.T('【飞行棋】{n} 邀请你来对战！房间号：{no}  一键进房：{link}').replace('{n}', state.nick).replace('{no}', no).replace('{link}', link));
      toast(I18N.T('已建房并复制邀请（房间号 {n}），发给好友即可').replace('{n}', no));
      if (notifyWs && notifyWs.readyState === 1) {
        try { notifyWs.send(JSON.stringify({ type: 'invite', to: f, from: state.nick, roomNo: no })); } catch (e) {}
      }
    } catch (e) { toast(I18N.T('邀战失败：') + apiErrMsg(e)); }
  }
  $('btnFriends').onclick = () => { loadFriends(); $('modal-friends').classList.add('show'); };
  $('btnFriendsClose').onclick = () => $('modal-friends').classList.remove('show');
  $('mfAddBtn').onclick = doAddFriend;
  if ($('mfInput')) $('mfInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAddFriend(); });

  // ================= v9 好友邀请卡 + 断线重连 =================
  let pendingInvite = null;
  function showInvite(d) {
    pendingInvite = d.roomNo;
    $('ivTitle').textContent = I18N.T('{n} 邀你进房').replace('{n}', d.fromNick || d.from || I18N.T('好友'));
    $('ivSub').textContent = I18N.T('房间号：') + d.roomNo;
    $('modal-invite').classList.add('show');
  }
  $('ivJoin').onclick = () => {
    $('modal-invite').classList.remove('show');
    if (pendingInvite) { $('joinNo').value = pendingInvite; showPanel('join'); doJoin(); }
  };
  $('ivIgnore').onclick = () => { $('modal-invite').classList.remove('show'); pendingInvite = null; };

  let _rcTimer = null;
  function showReconnect() {
    const m = $('reconnectMask'); if (!m) return; m.hidden = false;
    const t = m.querySelector('.rm-title'); if (t) t.textContent = I18N.T('连接断开，正在重连…'); // v38 重置标题（可能被上次的重试计数改写）
    let left = 10;
    const sub = $('rmSub'); if (sub) sub.textContent = I18N.T('剩 {n} 秒').replace('{n}', left);
    clearInterval(_rcTimer);
    _rcTimer = setInterval(() => {
      left -= 1;
      if (sub) sub.textContent = left > 0 ? I18N.T('剩 {n} 秒').replace('{n}', left) : I18N.T('正在等待网络恢复…');
    }, 1000);
  }
  function hideReconnect() {
    const m = $('reconnectMask'); if (m) m.hidden = true;
    clearInterval(_rcTimer);
  }

  // ================= v39 版本漂移检测 =================
  // 场景：PWA 装到主屏/页签长开后，服务器已发新版而本页还是旧 JS —— 心跳 pong 携带
  // 服务端版本，与本页 meta 对不上就弹「刷新」横幅，避免旧前端悄悄连新协议。
  let _updBanner = null;
  function checkVersionMatch(remote) {
    const meta = document.querySelector('meta[name="app-version"]');
    const local = meta && meta.content;
    if (remote && local && remote !== local) showUpdateBanner();
  }
  function showUpdateBanner() {
    if (_updBanner) return;
    _updBanner = document.createElement('div');
    _updBanner.className = 'upd-banner';
    _updBanner.innerHTML = '<span>' + I18N.T('检测到新版本，请刷新页面') + '</span>'
      + '<button>' + I18N.T('刷新') + '</button>';
    _updBanner.querySelector('button').onclick = () => location.reload();
    document.body.appendChild(_updBanner);
  }

  // ================= v12 通用 API 小工具 =================
  function jget(url) { return fetch(url).then((x) => x.json()); }
  function jpost(url, body) {
    // v15：所有 POST 统一附带账号凭证（服务端在需要的端点校验，其余忽略）
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ token: state.secret }, body || {})) }).then((x) => x.json());
  }
  // v16 统一 API 错误文案：把服务端错误码翻译成可行动的提示
  function apiErrMsg(e) {
    const code = String((e && e.message) || e || '');
    const map = {
      NICK_TAKEN: '该昵称已被其他设备占用：请换一个昵称，或在原设备「设置 → 账号凭证」复制后联系管理员',
      AUTH_FAILED: '账号凭证校验失败，请在设置里复制凭证并联系管理员重置',
      AUTH_REQUIRED: '账号凭证校验失败，请刷新页面后重试',
      RATE_LIMITED: '操作太频繁，稍等几秒再试',
      ROOM_NOT_FOUND: '房间不存在或已解散',
      GAME_STARTED: '对局已经开始，进入观战吧',
      WRONG_PASSWORD: '房间密码错误',
      PWD_LOCKED: '密码错误次数过多，请 10 分钟后再试',
    };
    return I18N.T(map[code] || code);
  }
  function needNick() {
    if (!state.nick) { toast(I18N.T('请先在大厅输入昵称')); return false; }
    return true;
  }

  // ================= v12 公会系统 =================
  let myGuild = null;
  async function openGuild() {
    $('modal-guild').classList.add('show');
    loadGuildMine();
    loadGuildRank();
    loadGuildWar(); // v13 公会战周榜
  }
  // v13 公会战（本周积分榜，周一清零）
  async function loadGuildWar() {
    const el = $('guildWar');
    if (!el) return;
    try {
      const res = await jget('/api/guild/war');
      const list = res.list || [];
      if (!list.length) { el.innerHTML = '<div class="rh-empty">本周还没有公会得分，快去打几局！</div>'; return; }
      el.innerHTML = list.map((g, i) => `<div class="gr-row${myGuild && g.gid === myGuild.gid ? ' mine' : ''}">
          <span class="gr-rank">${['🥇', '🥈', '🥉'][i] || (i + 1)}</span>
          <span class="gr-name">${escapeHtml(g.name)}</span>
          <span class="gr-mem">👥${g.members || 0}</span>
          <span class="gr-score">⚔️${g.weekScore || 0}</span>
        </div>`).join('');
    } catch (e) { el.innerHTML = '<div class="rh-empty">' + I18N.T('加载失败') + '</div>'; }
  }
  // ============ v13 福利中心（订阅 / 周任务 / 海报） ============
  async function openWelfare() {
    if (!state.nick) { toast(I18N.T('请先在大厅设置昵称')); return; }
    $('modal-bonus').classList.add('show');
    loadSub();
    loadWeekly();
  }
  async function loadSub() {
    const box = $('subBox');
    if (!box) return;
    try {
      const r = await jget('/api/sub?nick=' + encodeURIComponent(state.nick));
      if (r.active) {
        const typeName = r.type === 'month' ? I18N.T('月卡') : r.type === 'season' ? I18N.T('季卡') : I18N.T('订阅');
        box.innerHTML = '<div class="sub-active"><b>💎 ' + typeName + I18N.T('生效中') + '</b>' +
          '<span>' + I18N.T('剩余 {n} 天 · 每日登录自动领钻').replace('{n}', r.daysLeft || 0) + '</span>' +
          '<button class="primary sm" id="btnSubGrant">' + I18N.T('领取今日钻石') + '</button></div>';
        const g = $('btnSubGrant'); if (g) g.onclick = doSubGrant;
      } else {
        box.innerHTML = '<div class="sub-none"><p class="tip">' + I18N.T('订阅享每日钻石、专属奖励。') + '</p>' +
          '<button class="primary sm" data-st="month">💎 ' + I18N.T('开通月卡 (30天)') + '</button>' +
          '<button class="ghost sm" data-st="season">💎 ' + I18N.T('开通季卡 (90天)') + '</button></div>';
        box.querySelectorAll('[data-st]').forEach((b) => { b.onclick = () => doSubscribe(b.dataset.st); });
      }
    } catch (e) { box.innerHTML = '<div class="tip">加载失败</div>'; }
  }
  async function doSubscribe(type) {
    try {
      const r = await jpost('/api/subscribe', { nick: state.nick, type });
      if (r.ok) { toast(I18N.T('订阅成功！')); loadSub(); await doSubGrant(); }
      else toast(apiErrMsg({ message: r.error }));
    } catch (e) { toast(apiErrMsg(e)); }
  }
  async function doSubGrant() {
    try {
      const r = await jpost('/api/sub/grant', { nick: state.nick });
      if (r.ok && r.granted) toast(I18N.T('领取 {n} 钻石').replace('{n}', r.granted));
      else if (r.ok && !r.granted) toast(I18N.T('今日钻石已领过'));
      loadSub();
    } catch (e) { /* noop */ }
  }
  async function loadWeekly() {
    const el = $('weeklyList');
    if (!el) return;
    try {
      const r = await jget('/api/weekly?nick=' + encodeURIComponent(state.nick));
      const tasks = r.tasks || [];
      el.innerHTML = tasks.map((t) => '<div class="wk-row ' + (t.done ? 'done' : '') + '">' +
        '<i class="wk-ck">' + (t.done ? '✅' : '⬜') + '</i>' +
        '<span class="wk-name">' + escapeHtml(t.name) + '<em>' + escapeHtml(t.desc) + ' · ' + escapeHtml(t.reward) + '</em></span></div>').join('') +
        (r.claimed ? '<p class="tip">本周已领取奖励</p>' : '');
      const claimBtn = $('btnWeeklyClaim');
      if (claimBtn) claimBtn.disabled = !!(r.claimed || !tasks.some((t) => t.done));
    } catch (e) { el.innerHTML = '<div class="tip">加载失败</div>'; }
  }
  async function doWeeklyClaim() {
    try {
      const r = await jpost('/api/weekly/claim', { nick: state.nick });
      if (r.ok) { toast(I18N.T('领取成功！')); if (r.coins) updateCoin(r.coins); loadWeekly(); }
      else toast(I18N.T('领取失败：') + (r.error || ''));
    } catch (e) { toast(I18N.T('领取失败')); }
  }
  async function doAd(kind) {
    try {
      const r = await jpost('/api/ad/reward', { nick: state.nick, kind });
      if (r.ok) {
        const rw = r.reward || {};
        toast(I18N.T('奖励已发放：') + (rw.coins ? I18N.T('{n} 金币').replace('{n}', rw.coins) : I18N.T('{n} 钻石').replace('{n}', rw.diamonds || 0)));
        if (r.player && r.player.coins !== undefined) updateCoin(r.player.coins);
        loadSub();
      } else if (r.error === 'RATE_LIMITED') {
        toast(I18N.T('操作太频繁，{s}').replace('{s}', r.retryAfter ? I18N.T('{n} 秒后再试').replace('{n}', r.retryAfter) : I18N.T('稍后再试')));
      } else if (r.error === 'DAILY_LIMIT') {
        toast(I18N.T('今天看广告的次数已用完（金币 10 次 / 钻石 5 次），明天再来'));
      } else if (r.error === 'AUTH_FAILED' || r.error === 'AUTH_REQUIRED') {
        toast(I18N.T('账号凭证校验失败，请在设置里复制凭证并联系管理员重置'));
      } else toast(I18N.T('领取失败'));
    } catch (e) { toast(I18N.T('领取失败')); }
  }
  async function openSharePoster() {
    const cv = $('posterCanvas');
    const box = $('posterBox');
    if (!cv) return;
    box.hidden = false;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#1f1f3a'); grad.addColorStop(1, '#12121f');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 24px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(I18N.T('✈ 我的飞行棋战绩'), W / 2, 44);
    let p = null;
    try { p = await jget('/api/stats/player?nick=' + encodeURIComponent(state.nick)); } catch (e) { /* noop */ }
    const pl = (p && p.stats) || {};
    const games = pl.games || 0, wins = pl.wins || 0;
    const rate = games ? Math.round(wins / games * 100) : 0;
    ctx.fillStyle = '#cfcfe6'; ctx.font = '16px sans-serif';
    ctx.fillText(I18N.T('昵称：') + (state.nick || '—'), W / 2, 78);
    const cards = [[I18N.T('总对局'), games], [I18N.T('胜场'), wins], [I18N.T('胜率'), rate + '%'], [I18N.T('最佳连胜'), pl.bestStreak || 0]];
    cards.forEach((c, i) => {
      const x = 22 + (i % 2) * 162, y = 104 + Math.floor(i / 2) * 78;
      ctx.fillStyle = 'rgba(255,255,255,0.08)'; roundRect(ctx, x, y, 146, 62, 10); ctx.fill();
      ctx.fillStyle = '#8f7cff'; ctx.font = 'bold 21px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(String(c[1]), x + 73, y + 28);
      ctx.fillStyle = '#9a9ab0'; ctx.font = '12px sans-serif';
      ctx.fillText(c[0], x + 73, y + 48);
    });
    const url = location.origin + (state.roomNo ? '/?r=' + state.roomNo : '/');
    try {
      const px = 4; const probe = QR.make(url); const qb = (probe.size + 4) * px;
      const qx = (W - qb) / 2, qy = 286;
      ctx.fillStyle = '#fff'; roundRect(ctx, qx - 6, qy - 6, qb + 12, qb + 12, 10); ctx.fill();
      QR.draw(ctx, url, qx, qy, px, '#12121f', '#ffffff');
      ctx.fillStyle = '#e8e8f0'; ctx.font = '14px monospace'; ctx.textAlign = 'center';
      ctx.fillText(I18N.T('扫码来和我对战'), W / 2, qy + qb + 26);
    } catch (e) { /* noop */ }
  }
  // ============ 福利中心按钮事件绑定 ============
  if ($('btnBonus')) $('btnBonus').onclick = openWelfare;
  if ($('btnWeeklyClaim')) $('btnWeeklyClaim').onclick = doWeeklyClaim;
  if ($('btnAdCoin')) $('btnAdCoin').onclick = () => doAd('coin');
  if ($('btnAdDiamond')) $('btnAdDiamond').onclick = () => doAd('diamond');
  if ($('btnPoster')) $('btnPoster').onclick = openSharePoster;
  if ($('btnBonusClose')) $('btnBonusClose').onclick = () => $('modal-bonus').classList.remove('show');
  async function loadGuildMine() {
    const box = $('guildMine');
    if (!state.nick) { box.innerHTML = '<p class="tip">' + I18N.T('请先在大厅设置昵称后再来加入公会。') + '</p>'; myGuild = null; return; }
    try {
      const res = await jget('/api/guild/mine?nick=' + encodeURIComponent(state.nick));
      myGuild = res.guild || null;
      if (!myGuild) {
        box.innerHTML = '<p class="tip">你还没有公会。输入名字点「创建」，或输入公会 ID 点「加入」。</p>';
        return;
      }
      const members = (myGuild.members || []).map((m) => `<span class="gm-chip${m === state.nick ? ' me' : ''}">${escapeHtml(m)}</span>`).join('');
      box.innerHTML = `<div class="gm-head"><b>${escapeHtml(myGuild.name)}</b>
          <span class="gm-id">ID: ${escapeHtml(myGuild.gid)}</span>
          <span class="gm-score">⭐ ${myGuild.score || 0}</span></div>
        <div class="gm-members">${members}</div>
        <div class="gm-acts">
          <button class="ghost sm" id="gmCopy">复制邀请</button>
          <button class="ghost sm" id="gmLeave">退出公会</button>
        </div>`;
      $('gmCopy').onclick = () => {
        copyText(`【飞行棋公会】${myGuild.name}（ID: ${myGuild.gid}）—— 打开 ${location.origin} 顶栏「公会」填 ID 加入我们！`);
        toast(I18N.T('邀请已复制'));
      };
      $('gmLeave').onclick = async () => {
        const r = await jpost('/api/guild/leave', { nick: state.nick, gid: myGuild.gid });
        if (r.ok) { toast(I18N.T('已退出公会')); loadGuildMine(); loadGuildRank(); } else toast(I18N.T('退出失败：') + (r.error || ''));
      };
    } catch (e) { box.innerHTML = '<p class="tip">加载失败</p>'; }
  }
  async function loadGuildRank() {
    const el = $('guildRank');
    try {
      const res = await jget('/api/guild/rank');
      const list = res.list || [];
      if (!list.length) { el.innerHTML = '<div class="rh-empty">' + I18N.T('还没有公会，快来创建第一个！') + '</div>'; return; }
      el.innerHTML = list.map((g, i) => `<div class="gr-row${myGuild && g.gid === myGuild.gid ? ' mine' : ''}">
          <span class="gr-rank">${['🥇', '🥈', '🥉'][i] || (i + 1)}</span>
          <span class="gr-name">${escapeHtml(g.name)}</span>
          <span class="gr-mem">👥${typeof g.members === 'number' ? g.members : ((g.members || []).length)}</span>
          <span class="gr-score">⭐${g.score || 0}</span>
        </div>`).join('');
    } catch (e) { el.innerHTML = '<div class="rh-empty">' + I18N.T('加载失败') + '</div>'; }
  }
  async function doGuildCreate() {
    if (!needNick()) return;
    const name = ($('guildInput').value || '').trim();
    if (!name) { toast(I18N.T('请输入公会名')); return; }
    const r = await jpost('/api/guild/create', { nick: state.nick, name });
    if (r.ok) { $('guildInput').value = ''; toast(I18N.T('公会已创建：') + (r.guild && r.guild.gid || '')); loadGuildMine(); loadGuildRank(); }
    else toast(I18N.T('创建失败：') + (r.error || ''));
  }
  async function doGuildJoin() {
    if (!needNick()) return;
    const gid = ($('guildInput').value || '').trim();
    if (!gid) { toast(I18N.T('请输入公会 ID')); return; }
    const r = await jpost('/api/guild/join', { nick: state.nick, gid });
    if (r.ok) { $('guildInput').value = ''; toast(I18N.T('已加入公会')); loadGuildMine(); loadGuildRank(); }
    else toast(I18N.T('加入失败：') + (r.error === 'GUILD_NOT_FOUND' ? I18N.T('公会 ID 不存在') : (r.error || '')));
  }
  if ($('btnGuild')) $('btnGuild').onclick = openGuild;
  if ($('btnGuildClose')) $('btnGuildClose').onclick = () => $('modal-guild').classList.remove('show');
  if ($('guildCreateBtn')) $('guildCreateBtn').onclick = doGuildCreate;
  if ($('guildJoinBtn')) $('guildJoinBtn').onclick = doGuildJoin;

  // ================= v12 PVE 闯关 =================
  async function openPve() {
    $('modal-pve').classList.add('show');
    loadPve();
  }
  async function loadPve() {
    const el = $('pveList');
    el.innerHTML = '<div class="rh-empty">' + I18N.T('加载中…') + '</div>';
    try {
      const res = await jget('/api/pve/levels?nick=' + encodeURIComponent(state.nick || ''));
      const p = res.pve || { levels: [], cleared: 0, total: 0 };
      $('pveTip').textContent = I18N.T('已通关 {a}/{b} 关 · 当前可挑战第 {c} 关。AI 越往后越强，还会带初始劣势。').replace('{a}', p.cleared).replace('{b}', p.total).replace('{c}', p.next);
      const sub = $('pveSub');
      if (sub) sub.textContent = I18N.T('进度 {a}/{b} 关').replace('{a}', p.cleared).replace('{b}', p.total);
      el.innerHTML = p.levels.map((L) => `<div class="pve-row ${L.passed ? 'passed' : (L.unlocked ? 'open' : 'lock')}">
          <span class="pv-lv">${L.passed ? '✅' : (L.unlocked ? '▶' : '🔒')} ${L.lv}</span>
          <span class="pv-name">${escapeHtml(L.name)}<em>${escapeHtml(L.handicap)} · 电脑 Lv${L.aiLevel}</em></span>
          <span class="pv-coin">🪙${L.coins}</span>
          ${L.unlocked ? `<button class="primary sm pv-go" data-lv="${L.lv}">${L.passed ? I18N.T('重打') : I18N.T('挑战')}</button>` : '<span class="pv-lock">' + I18N.T('未解锁') + '</span>'}
        </div>`).join('');
      el.querySelectorAll('.pv-go').forEach((b) => { b.onclick = () => doPveStart(Number(b.dataset.lv)); });
    } catch (e) { el.innerHTML = '<div class="rh-empty">' + I18N.T('加载失败') + '</div>'; }
  }
  async function doPveStart(lv) {
    if (!needNick()) return;
    try {
      const r = await jpost('/api/rooms/pve/start', { nick: state.nick, level: lv });
      if (!r.ok) { toast(I18N.T('开局失败：') + (r.error === 'LEVEL_LOCKED' ? I18N.T('该关卡尚未解锁') : (r.error || ''))); return; }
      $('modal-pve').classList.remove('show');
      state.roomNo = r.roomNo; state.seat = 0; state.clientId = r.hostClientId; saveState();
      const rr = await FlyAPI.getRoom(r.roomNo);
      currentRoom = rr.room;
      switchView('game');
      renderRoom(rr.room);
      connectWS();
      toast(I18N.T('第 {n} 关「{name}」开始！').replace('{n}', r.level).replace('{name}', r.name));
    } catch (e) { toast(I18N.T('开局失败：') + apiErrMsg(e)); }
  }
  if ($('btnPve')) $('btnPve').onclick = openPve;
  if ($('btnPveClose')) $('btnPveClose').onclick = () => $('modal-pve').classList.remove('show');

  // ================= v12 每日残局 =================
  // 玩法：4 架飞机各差 N 格到家，按顺序消耗给定骰子，超出则回弹，全部精确到家即通关。
  let pz = null; // { dice[], rem[], cur[], moves[], solved }
  async function openPuzzle() {
    $('modal-puzzle').classList.add('show');
    await loadPuzzle();
  }
  async function loadPuzzle() {
    try {
      const res = await jget('/api/puzzle/today?nick=' + encodeURIComponent(state.nick || ''));
      const p = res.puzzle;
      pz = { date: p.date, dice: p.dice.slice(), rem: p.rem.slice(), cur: p.rem.slice(), moves: [], solved: !!p.solved, reward: p.reward };
      const sub = $('puzzleSub');
      if (sub) sub.textContent = pz.solved ? I18N.T('今日已通关 ✅') : I18N.T('{n} 步 · 奖励 🪙{c}').replace('{n}', pz.dice.length).replace('{c}', pz.reward.coins);
      $('puzzleTip').innerHTML = pz.solved
        ? I18N.T('今天这道题你已经解出来了 ✅ 明天 00:00 换新题（还能再练一遍，不重复发奖）。')
        : I18N.T('按顺序把每颗骰子分配给一架飞机，<b>超出距离会回弹</b>，把 4 架全部精确送回家即通关，奖励 🪙{c} + 1 张随机道具卡。').replace('{c}', pz.reward.coins);
      renderPuzzle();
    } catch (e) { $('puzzleTip').textContent = '加载失败'; }
  }
  function renderPuzzle() {
    if (!pz) return;
    const cv = $('puzzleBoard');
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const colors = ['#e8443c', '#f0b429', '#2f6fe0', '#22a06b'];
    const laneH = 74, padL = 44, padR = 24, top = 16;
    const step = pz.moves.length;
    const dice = step < pz.dice.length ? pz.dice[step] : null;
    for (let i = 0; i < 4; i++) {
      const y = top + i * laneH + laneH / 2;
      const x0 = padL, x1 = W - padR;
      const maxD = 14;
      // 跑道
      ctx.strokeStyle = 'rgba(38,44,102,.14)'; ctx.lineWidth = 10; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      // 家（右端）
      ctx.fillStyle = pz.cur[i] === 0 ? colors[i] : 'rgba(38,44,102,.25)';
      ctx.beginPath(); ctx.arc(x1, y, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(I18N.T('家'), x1, y);
      // 飞机位置：距离越远越靠左
      const t = Math.min(1, pz.cur[i] / maxD);
      const px = x1 - (x1 - x0) * t;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.2)'; ctx.shadowBlur = 6;
      ctx.fillStyle = colors[i];
      ctx.beginPath();
      ctx.moveTo(px + 11, y); ctx.lineTo(px - 8, y - 8); ctx.lineTo(px - 3, y); ctx.lineTo(px - 8, y + 8);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = 'rgba(122,62,0,.5)'; ctx.lineWidth = 1.4; ctx.stroke();
      // 左侧编号 + 剩余距离
      ctx.fillStyle = '#262c66'; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'left';
      ctx.fillText(String(i + 1), 8, y - 8);
      ctx.fillStyle = pz.cur[i] === 0 ? '#22a06b' : '#5a608f'; ctx.font = '12px system-ui';
      ctx.fillText(pz.cur[i] === 0 ? I18N.T('到家') : I18N.T('差{n}').replace('{n}', pz.cur[i]), 6, y + 10);
      // 可点提示：当前骰子作用于该机的预览
      if (dice !== null && pz.cur[i] > 0) {
        const nx = dice > pz.cur[i] ? dice - pz.cur[i] : pz.cur[i] - dice;
        ctx.fillStyle = nx === 0 ? 'rgba(34,160,107,.9)' : 'rgba(38,44,102,.45)';
        ctx.font = '11px system-ui'; ctx.textAlign = 'right';
        ctx.fillText(nx === 0 ? I18N.T('→ 到家!') : I18N.T('→ 差{n}').replace('{n}', nx), x1 - 22, y - 16);
      }
    }
    // 骰子条
    const db = $('pzDice');
    db.innerHTML = pz.dice.map((d, i) => `<span class="pzd${i < step ? ' used' : (i === step ? ' now' : '')}">${d}</span>`).join('');
    $('pzStep').textContent = I18N.T('步数 {a}/{b}').replace('{a}', step).replace('{b}', pz.dice.length);
    $('pzHome').textContent = I18N.T('到家 {n}/4').replace('{n}', pz.cur.filter((r) => r === 0).length);
    $('btnPzRoll').disabled = true;
    $('btnPzRoll').textContent = dice === null ? I18N.T('已走完') : I18N.T('当前骰子 {n} → 点飞机').replace('{n}', dice);
  }
  function puzzleApply(i) {
    if (!pz) return;
    const step = pz.moves.length;
    if (step >= pz.dice.length) return;
    if (pz.cur[i] === 0) { toast(I18N.T('这架已经到家了')); return; }
    const d = pz.dice[step];
    pz.cur[i] = d > pz.cur[i] ? d - pz.cur[i] : pz.cur[i] - d;
    pz.moves.push(i);
    Sfx.move && Sfx.move();
    renderPuzzle();
    if (pz.moves.length === pz.dice.length) {
      if (pz.cur.every((r) => r === 0)) doPuzzleClaim();
      else toast(I18N.T('骰子用完了但还没全部到家，点「重来」再试'));
    }
  }
  async function doPuzzleClaim() {
    if (!state.nick) { toast(I18N.T('通关了！但要设置昵称才能领奖')); return; }
    try {
      const r = await jpost('/api/puzzle/claim', { nick: state.nick, moves: pz.moves });
      if (r.ok && r.already) { toast(I18N.T('通关！今天的奖励已领过')); }
      else if (r.ok) {
        toast(I18N.T('🎉 残局通关！+🪙{n}').replace('{n}', r.gained || (pz.reward && pz.reward.coins) || 0) + (r.prop ? I18N.T(' + 道具「{p}」').replace('{p}', r.prop) : ''));
        if (r.coins !== undefined) updateCoin(r.coins);
        Sfx.win && Sfx.win();
      } else toast(I18N.T('领奖失败：') + (r.error === 'NOT_SOLVED' ? I18N.T('方案未解出') : (r.error || '')));
      pz.solved = true;
      const sub = $('puzzleSub'); if (sub) sub.textContent = '今日已通关 ✅';
    } catch (e) { toast(I18N.T('领奖失败')); }
  }
  function doPuzzleReset() {
    if (!pz) return;
    pz.cur = pz.rem.slice(); pz.moves = [];
    renderPuzzle();
  }
  if ($('puzzleBoard')) {
    $('puzzleBoard').addEventListener('click', (e) => {
      if (!pz) return;
      const cv = $('puzzleBoard');
      const rect = cv.getBoundingClientRect();
      const y = (e.clientY - rect.top) * (cv.height / rect.height);
      const laneH = 74, top = 16;
      const i = Math.floor((y - top) / laneH);
      if (i >= 0 && i < 4) puzzleApply(i);
    });
  }
  if ($('btnPuzzle')) $('btnPuzzle').onclick = openPuzzle;
  if ($('btnPuzzleClose')) $('btnPuzzleClose').onclick = () => $('modal-puzzle').classList.remove('show');
  if ($('btnPzReset')) $('btnPzReset').onclick = doPuzzleReset;
  if ($('btnPzRoll')) $('btnPzRoll').onclick = () => toast(I18N.T('点左边的飞机来分配当前骰子'));

  // ================= v12 举报 =================
  async function doReport(target) {
    if (!needNick()) return;
    if (!target || target === state.nick) { toast(I18N.T('不能举报自己')); return; }
    const reason = prompt(I18N.T('举报 {nick} 的理由（可留空）：').replace('{nick}', target), I18N.T('言语不当'));
    if (reason === null) return;
    try {
      const r = await jpost('/api/report', { nick: state.nick, target, reason: reason || '' });
      toast(r.ok ? I18N.T('已举报，管理员会处理') : I18N.T('举报失败：') + (r.error || ''));
    } catch (e) { toast(I18N.T('举报失败')); }
  }

  // ================= v12 多语言 =================
  function applyLang(lang) {
    if (!window.I18N) return;
    I18N.apply(lang);
    const sel = $('stLang'); if (sel) sel.value = I18N.lang;
  }
  if ($('stLang')) {
    $('stLang').onchange = () => applyLang($('stLang').value);
  }
  window.addEventListener('langchange', () => {
    // 动态列表要重渲染才能吃到译文
    if ($('modal-pve').classList.contains('show')) loadPve();
    if ($('modal-guild').classList.contains('show')) loadGuildRank();
  });

  // ================= 规则弹窗 =================
  function openRules() { $('modal-rules').classList.add('show'); }
  function closeRules() { $('modal-rules').classList.remove('show'); }
  $('btnRules').onclick = openRules;
  $('btnRules2').onclick = openRules;
  $('btnRulesClose').onclick = closeRules;
  $('modal-rules').addEventListener('click', (e) => { if (e.target === $('modal-rules')) closeRules(); });
  $('modal-lb').addEventListener('click', (e) => {
    if (e.target === $('modal-lb')) $('modal-lb').classList.remove('show');
  });

  // ================= 启动：尝试恢复 =================
  (async () => {
    if (state.nick) { $('createNick').value = state.nick; $('joinNick').value = state.nick; }
    // v7 #18 分享深链：?r=房间号 → 自动填入并展开加入面板
    const _inv = new URLSearchParams(location.search).get('r');
    if (_inv) {
      const _no = String(_inv).replace(/[^0-9]/g, '').slice(0, 6);
      if (_no) {
        $('joinNo').value = _no;
        showPanel('join');
        toast(I18N.T('已为你填入房间号 {n}，点「加入房间」即可和好友对战').replace('{n}', _no));
      }
    }
    // v12 多语言：先按上次选择渲染，再跑其他初始化（避免中文一闪）
    try { applyLang(window.I18N ? I18N.saved() : 'zh'); } catch (e) { /* ignore */ }
    refreshHalls();
    setInterval(refreshHalls, 15000); // v7 大厅在线房间 15 秒自动刷新
    // v12 大厅入口副标题：闯关进度 / 今日残局状态
    try {
      const [pv, pq] = await Promise.all([
        jget('/api/pve/levels?nick=' + encodeURIComponent(state.nick || '')),
        jget('/api/puzzle/today?nick=' + encodeURIComponent(state.nick || '')),
      ]);
      if (pv && pv.pve && $('pveSub')) $('pveSub').textContent = `进度 ${pv.pve.cleared}/${pv.pve.total} 关`;
      if (pq && pq.puzzle && $('puzzleSub')) $('puzzleSub').textContent = pq.puzzle.solved ? '今日已通关 ✅' : `${pq.puzzle.dice.length} 步挑战 · 🪙${pq.puzzle.reward.coins}`;
    } catch (e) { /* ignore */ }
    loadServerStats();
    setInterval(loadServerStats, 15000); // v9 顶栏在线统计
    loadAnnounce(); // v8 公告条
    if (state.nick) connectNotify(); // v9 常驻好友通知 WS
    setInterval(() => { if (notifyWs && notifyWs.readyState === 1) { try { notifyWs.send(JSON.stringify({ type: 'heartbeat' })); } catch (e) {} } }, 20000);
    if (state.nick) { // v8 启动即恢复金币与已装备皮肤
      try {
        const res = await fetch('/api/stats/player?nick=' + encodeURIComponent(state.nick)).then((x) => x.json());
        if (res.player) {
          if (res.player.equipped) { state.equipped = res.player.equipped; saveState(); }
          applySkin(state.theme || state.equipped || 'classic');
          updateCoin(res.player.coins || 0);
        }
      } catch (e) { /* ignore */ }
    }
    // v9 回合倒计时本地平滑倒数；v33：不在对局中就不空跑（原实现离开房间后仍 200ms 轮询）
    setInterval(() => { if (currentRoom && currentGame) updateTurnTimer(); }, 200);
    bindRulesPanel(); // v13 自定义规则面板事件绑定
    loadEvents(); // v13 限时活动中心
    if (state.roomNo) {
      try {
        const r = await FlyAPI.getRoom(state.roomNo);
        currentRoom = r.room;
        if (r.room.status === 'playing') switchView('game'); else switchView('room');
        renderRoom(r.room);
        connectWS();
      } catch (e) {
        state.roomNo = undefined; saveState();
        switchView('lobby'); // v25 兜底：房号失效/网络闪断时回大厅，避免三视图全无的空白页
      }
    } else {
      switchView('lobby'); // v25 无房号时显式落大厅（与初始 HTML active 双保险）
    }
  })();
})();
