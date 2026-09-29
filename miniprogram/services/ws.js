// services/ws.js — 微信小程序直连网页版飞行棋服务器的 WebSocket 适配器
//
// 网页版服务器实时通道协议（server/src/websocket.js）：
//   连接：  wx.connectSocket({ url: 'wss://<host>/ws?roomNo=XXX&seat=Y&clientId=Z' })
//   收包：  JSON.stringify({ type, data })  —— type ∈ state|chat|game_over|emoji|error|invite|pong
//   发包：  ws.send(JSON.stringify(obj))
//
// 使用方式（在需要实时对局的页面 onLoad 里）：
//   const GameSocket = require('../../services/ws.js');
//   const sock = new GameSocket({
//     host: '129.211.29.228:3000',   // 不填则用下方 DEFAULT_HOST
//     roomNo, seat, clientId,
//     handlers: {
//       onOpen() {}, onState(s) {}, onChat(c) {}, onGameOver(d) {},
//       onEmoji(e) {}, onError(e) {}, onInvite(i) {}, onClose() {}
//     }
//   });
//   sock.connect();
//   // 走子：sock.send({ type:'roll' }) 或 { type:'move', planeId, dice } 等（以服务器动作名为准）
//   // 页面 onUnload：sock.close();
//
// 说明：小程序壳原本走「云函数 + 数据库轮询」架构；本适配器是可选「直连模式」，
// 用于复用同一套棋盘组件渲染网页版推送的实时 state。需在小程序后台配置 socket 合法域名
// （wss://<host>），并在 app.js 暴露 globalData.wsHost 或在调用处显式传入 host。

const DEFAULT_HOST = '129.211.29.228:3000';

class GameSocket {
  constructor({ host, roomNo, seat, clientId, handlers }) {
    this.host = (host || (wx.getStorageSync('fc_ws_host') || '') || DEFAULT_HOST);
    this.roomNo = roomNo;
    this.seat = seat;
    this.clientId = clientId || ('wx_' + Date.now() + '_' + Math.floor(Math.random() * 1e4));
    this.h = handlers || {};
    this.task = null;       // wx.connectSocket 返回的 SocketTask
    this.shouldClose = false;
  }

  connect() {
    const proto = this.host.startsWith('localhost') || /:80$/.test(this.host) ? 'ws' : 'wss';
    const q = `roomNo=${encodeURIComponent(this.roomNo)}&seat=${encodeURIComponent(this.seat)}&clientId=${encodeURIComponent(this.clientId)}`;
    const url = `${proto}://${this.host}/ws?${q}`;
    this.shouldClose = false;
    this.task = wx.connectSocket({ url });
    this.task.onOpen(() => { this.h.onOpen && this.h.onOpen(); });
    this.task.onMessage((res) => {
      let msg;
      try { msg = JSON.parse(res.data); } catch (e) { return; }
      const t = msg.type;
      if (t === 'state') this.h.onState && this.h.onState(msg.data);
      else if (t === 'chat') this.h.onChat && this.h.onChat(msg.data);
      else if (t === 'game_over') this.h.onGameOver && this.h.onGameOver(msg.data);
      else if (t === 'emoji') this.h.onEmoji && this.h.onEmoji(msg.data);
      else if (t === 'error') this.h.onError && this.h.onError(msg.data);
      else if (t === 'invite') this.h.onInvite && this.h.onInvite(msg.data);
      else if (t === 'pong') { /* 心跳 ack */ }
    });
    this.task.onClose(() => {
      this.h.onClose && this.h.onClose();
      if (!this.shouldClose) setTimeout(() => this.connect(), 1500); // 断线自动重连
    });
    this.task.onError((e) => {
      console.error('[ws] error', e);
      try { this.task.close(); } catch (err) { /* ignore */ }
    });
    return this;
  }

  send(obj) {
    if (this.task && typeof this.task.send === 'function') {
      this.task.send({ data: JSON.stringify(obj) });
    }
  }

  heartbeat() { this.send({ type: 'heartbeat' }); }

  close() {
    this.shouldClose = true;
    if (this.task) {
      try { this.task.close(); } catch (e) { /* ignore */ }
      this.task = null;
    }
  }
}

module.exports = GameSocket;
