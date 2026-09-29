/* api.js — HTTP 房间接口 + WebSocket 对局连接封装 */

const FlyAPI = (function () {
  const BASE = '/api/rooms';
  let token = ''; // v15 账号凭证（app.js 启动时 setToken 注入，建房/加入认领、财富操作校验）
  async function req(method, url, body) {
    const opt = { method, headers: {} };
    if (body) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(url, opt);
    let data = {};
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }
  const withToken = (body) => Object.assign({ token }, body || {});
  return {
    setToken: (t) => { token = String(t || ''); },
    createRoom: ({ password, settings, nickName }) =>
      req('POST', BASE, withToken({ password, settings, nickName })),
    listRooms: () => req('GET', BASE + '/list'),
    statsTop: (n) => req('GET', '/api/stats/top?n=' + (n || 10)),
    statsPlayer: (nick) => req('GET', '/api/stats/player?nick=' + encodeURIComponent(nick)),
    getRoom: (roomNo) => req('GET', BASE + '/' + roomNo),
    joinRoom: (roomNo, { password, clientId, nickName, watch }) =>
      req('POST', BASE + '/' + roomNo + '/join', withToken({ password, clientId, nickName, watch })),
    takeover: (roomNo, seat, { clientId, nickName }) =>
      req('POST', BASE + '/' + roomNo + '/takeover', withToken({ seat, clientId, nickName })),
    setSeat: (roomNo, { seat, action, aiLevel, requesterSeat, hostStyle }) =>
      req('POST', BASE + '/' + roomNo + '/seat', withToken({ seat, action, aiLevel, requesterSeat, hostStyle })),
    // v13 房主改自定义规则
    updateSettings: (roomNo, requesterSeat, settings) =>
      req('POST', BASE + '/' + roomNo + '/settings', { requesterSeat, settings }),
    startGame: (roomNo, requesterSeat) =>
      req('POST', BASE + '/' + roomNo + '/start', { requesterSeat }),
    restartRoom: (roomNo, requesterSeat) =>
      req('POST', BASE + '/' + roomNo + '/restart', { requesterSeat }),
    listReplays: () => req('GET', '/api/replays'),
    getReplay: (roomNo) => req('GET', '/api/replays/' + roomNo),
    serverStats: () => req('GET', '/api/stats/server'),

    // ============ v13 社交 2.0 ============
    friendList: (nick) => req('GET', '/api/friend/list?nick=' + encodeURIComponent(nick)),
    friendAdd: (nick, friend) => req('POST', '/api/friend/add', withToken({ nick, friend })),
    friendRemove: (nick, friend) => req('POST', '/api/friend/remove', withToken({ nick, friend })),
    transferCoins: (from, to, amount) => req('POST', '/api/coins/transfer', withToken({ from, to, amount })),
    guildWar: () => req('GET', '/api/guild/war'),

    // ============ v13 留存运营 ============
    subscribe: (nick, type) => req('POST', '/api/subscribe', withToken({ nick, type })),
    subState: (nick) => req('GET', '/api/sub?nick=' + encodeURIComponent(nick)),
    subGrant: (nick) => req('POST', '/api/sub/grant', withToken({ nick })),
    weekly: (nick) => req('GET', '/api/weekly?nick=' + encodeURIComponent(nick)),
    weeklyClaim: (nick) => req('POST', '/api/weekly/claim', withToken({ nick })),
    daily: (nick) => req('GET', '/api/daily?nick=' + encodeURIComponent(nick)),
    dailyClaim: (nick) => req('POST', '/api/daily/claim', withToken({ nick })),
    events: () => req('GET', '/api/events'),
    adReward: (nick, kind) => req('POST', '/api/ad/reward', withToken({ nick, kind })),
  };
})();

// v38 GameSocket：心跳保活 + 半开连接检测 + 指数退避重连 + 回前台即时探测
// 背景：手机弱网（WiFi↔4G、锁屏）最容易出现 TCP 半开——socket 看似连着，实际已死，
// 不发心跳的话客户端要等数分钟 TCP 超时才发现，对局早被 AI 托管了。
class GameSocket {
  constructor({ roomNo, seat, clientId, handlers }) {
    this.params = { roomNo, seat, clientId };
    this.h = handlers || {};
    this.shouldClose = false;
    this.retry = 0;        // 连续重连次数（成功后归零）
    this.lastAlive = 0;    // 最近一次收到服务端任意消息的时间
    this.hbTimer = null;
    // 回前台立即探测：锁屏/切走时定时器被浏览器节流，回来的第一时间主动查活
    this._onVis = () => {
      if (document.visibilityState !== 'visible' || !this.ws) return;
      if (this.ws.readyState === 1) {
        if (Date.now() - this.lastAlive > 15000) { this._stale(); return; }
        try { this.ws.send(JSON.stringify({ type: 'heartbeat' })); } catch (e) { /* ignore */ }
      }
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVis);
    this.connect();
  }
  _stale() {
    // 半开判定：超过 15 秒没有任何服务端消息 → 主动断开，走 onclose 重连
    try { this.ws.close(); } catch (e) { /* ignore */ }
  }
  _startHb() {
    clearInterval(this.hbTimer);
    this.lastAlive = Date.now();
    // 立即发首拍：新连接先做一次活性确认，之后每 5 秒一拍
    try { this.ws.send(JSON.stringify({ type: 'heartbeat' })); } catch (e) { /* ignore */ }
    this.hbTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      if (Date.now() - this.lastAlive > 15000) { this._stale(); return; }
      try { this.ws.send(JSON.stringify({ type: 'heartbeat' })); } catch (e) { /* ignore */ }
    }, 5000);
  }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = `roomNo=${encodeURIComponent(this.params.roomNo)}&seat=${this.params.seat}&clientId=${encodeURIComponent(this.params.clientId)}`;
    const url = `${proto}://${location.host}/ws?${q}`;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { setTimeout(() => this.connect(), 1500); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this._startHb();
      this.h.onOpen && this.h.onOpen();
    };
    ws.onmessage = (ev) => {
      this.lastAlive = Date.now(); // 任何入站消息都是活性的证据
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'state') this.h.onState && this.h.onState(msg.data);
      else if (msg.type === 'chat') this.h.onChat && this.h.onChat(msg.data);
      else if (msg.type === 'game_over') this.h.onGameOver && this.h.onGameOver(msg.data);
      else if (msg.type === 'emoji') this.h.onEmoji && this.h.onEmoji(msg.data);
      else if (msg.type === 'error') this.h.onError && this.h.onError(msg.data);
      else if (msg.type === 'invite') this.h.onInvite && this.h.onInvite(msg.data);
      else if (msg.type === 'pong') {
        // v39 版本漂移检测：pong 携带服务端版本，与本页 meta 对不上说明本页是旧 JS
        const remote = msg.data && msg.data.v;
        const meta = document.querySelector('meta[name="app-version"]');
        const local = meta && meta.content;
        if (remote && local && remote !== local) this.h.onStale && this.h.onStale(remote);
      }
    };
    ws.onclose = () => {
      clearInterval(this.hbTimer);
      this.h.onClose && this.h.onClose();
      if (this.shouldClose) return;
      // v38 退避重连：1.2s 起、×1.7、封顶 10s；把第 N 次尝试反馈给 UI
      const delay = Math.min(Math.round(1200 * Math.pow(1.7, this.retry)), 10000);
      this.retry++;
      this.h.onRetry && this.h.onRetry(this.retry, delay);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }
  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  close() {
    this.shouldClose = true;
    clearInterval(this.hbTimer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVis);
    try { this.ws.close(); } catch (e) { /* ignore */ }
  }
}
