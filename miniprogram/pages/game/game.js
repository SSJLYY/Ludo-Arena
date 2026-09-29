// 对局页：watch 快照队列 → 依次播放动画；真人只提交 action；
// AI/托管座位由任一在线客户端触发 AI_STEP，服务端权威结算
const api = require('../../services/api.js');
const sync = require('../../services/sync.js');
const cloudFn = require('../../utils/cloud.js');
const audio = require('../../utils/audio.js');
const animator = require('../../utils/animator.js');
const rulesText = require('../../utils/rules-text.js');
const view = require('../../engine/view.js');

const SPECTATOR_DELAY = 2500; // 观战延迟（防偷跑报点）

Page({
  data: {
    gameId: '',
    game: null,
    boardSize: 340,
    diceVal: 1,
    playersView: [],
    mySeat: -1,
    hostedMe: false,
    hostedOn: false,
    canRoll: false,
    canSelect: false,
    canReroll: false,
    hintText: '正在进入对局…',
    winBanner: '',
    exiting: false,
    muted: audio.isEnabled(),
    emoteTypes: ['👍', '😂', '😭', '🎉', '😡', '🤔', '🚀', '💥'],
    bubble: '',
    showStats: false,
    showRules: false,
    rules: rulesText.RULES,
    diceHistory: [],
    emoteCd: false,
    emoteCdSec: 0,
    spectatorCount: 0,
    spectatorNames: [],
    roomNo: ''
  },

  onLoad(options) {
    const gameId = options && options.gameId;
    if (!gameId) {
      wx.reLaunch({ url: '/pages/hall/hall' });
      return;
    }
    this.gameId = gameId;
    this.queue = [];
    this.applying = false;
    this.aiPending = false;
    this.lastSeq = -1;
    this.lastTurnSeat = -1;
    this.lastEmoteTs = null;
    this.hostedOn = false;
    this.redirected = false;

    const info = wx.getSystemInfoSync();
    const boardSize = Math.max(280, Math.min(info.windowWidth - 32, info.windowHeight - 360, 430));
    this.setData({ gameId: gameId, boardSize: boardSize });

    api.fetchGame(gameId).then((game) => {
      if (!game) return this.onGameGone();
      if (game.status === 'finished') return this.gotoResult();
      this.roomId = game.roomId;
      this.session = sync.createSession({
        gameId: gameId,
        roomId: game.roomId,
        hostedProvider: () => this.hostedOn,
        onGame: (doc) => {
          this.queue.push(doc);
          this.processQueue();
        },
        onRoom: (doc) => {
          this.roomDoc = doc;
          // v1.12 房号展示（供报号/复制）
          if (doc.roomNo && doc.roomNo !== this.data.roomNo) {
            this.setData({ roomNo: doc.roomNo });
          }
          this.processEmotes(doc);
          this.deriveView();
        }
      });
      this.session.start();
    }).catch(() => this.onGameGone());
  },

  onShow() {
    // 回前台兜底：主动拉取对局快照，防止后台期间 watch 静默断开
    if (this.gameId && this.session) {
      api.fetchGame(this.gameId).then((doc) => {
        if (doc && (doc.seq || 0) > this.lastSeq) {
          this.queue.push(doc);
          this.processQueue();
        }
      }).catch(() => { });
    }
  },

  onUnload() {
    if (this.session) this.session.stop();
    if (this.emoteCdTimer) clearInterval(this.emoteCdTimer);
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
  },

  onGameGone() {
    wx.showToast({ title: '对局不存在', icon: 'none' });
    setTimeout(() => wx.reLaunch({ url: '/pages/hall/hall' }), 900);
  },

  gotoResult() {
    if (this.redirected) return;
    this.redirected = true;
    setTimeout(() => {
      wx.redirectTo({ url: '/pages/result/result?gameId=' + this.gameId });
    }, 1800);
  },

  // ---------- 快照队列 ----------
  // 观战者延迟应用快照（首帧除外），防止实时报点
  isSpectatorDoc(doc) {
    if (!doc || !doc.players) return false;
    const oid = (getApp().globalData.openId || '');
    return !doc.players.some((p) => p.type === 'human' && p.openId && p.openId === oid);
  },

  async processQueue() {
    if (this.applying) return;
    this.applying = true;
    try {
      while (this.queue.length) {
        const doc = this.queue.shift();
        if (this.lastSeq >= 0 && this.isSpectatorDoc(doc)) {
          await animator.sleep(SPECTATOR_DELAY);
        }
        await this.playDoc(doc);
      }
    } finally {
      this.applying = false;
    }
    this.afterDrain();
  },

  async playDoc(doc) {
    const seq = doc.seq || 0;
    if (seq <= this.lastSeq) return; // 重复快照去重
    const animate = seq === this.lastSeq + 1 || this.lastSeq < 0;
    const events = doc.events || [];

    // 骰子动画（追帧时直接落点）
    const rollEv = events.find((e) => e.type === 'roll');
    if (rollEv && animate) {
      await this.selectComponent('#dice').rollTo(rollEv.dice);
    } else if (rollEv) {
      this.setData({ diceVal: rollEv.dice });
    }
    // v1.6 重掷也有骰子翻滚动画
    const rerollEv = events.find((e) => e.type === 'reroll');
    if (rerollEv && animate) {
      await this.selectComponent('#dice').rollTo(rerollEv.dice);
      audio.hop();
    }

    // 棋盘动画
    const board = this.selectComponent('#board');
    if (board) await board.playSnapshot(doc);
    this.lastSeq = seq;

    // 事件音效（跳过/作废/胜利）
    if (animate) {
      if (events.some((e) => e.type === 'void')) {
        wx.showToast({ title: '连掷三个 6，回合作废', icon: 'none' });
      }
      if (events.some((e) => e.type === 'win')) {
        audio.win();
      }
    }

    this.setData({
      game: doc,
      diceVal: doc.dice || this.data.diceVal,
      diceHistory: (doc.diceHistory || []).slice(-8)
    });
    this.lastSnapAt = Date.now();

    // v1.6 获得道具气泡 / v1.8 护盾反震播报（反震优先）
    const reflectEv = events.find((e) => e.type === 'move' && (e.kills || []).some((k) => k.blocked));
    const gainEv = events.find((e) => e.type === 'gain_item');
    if (reflectEv && animate) {
      audio.gain();
      this.showBubble('🛡 护盾反震！进攻机被撞回基地');
    } else if (gainEv && animate) {
      audio.gain();
      const holder = doc.players[gainEv.seat];
      this.showBubble((holder ? holder.nickName + ' ' : '') +
        (gainEv.item === 'shield' ? '🛡 获得护盾' : '🔄 获得重掷卡'));
    }

    this.deriveView();
  },

  afterDrain() {
    const game = this.data.game;
    if (!game) return;
    if (game.status === 'finished') {
      const winner = game.players[game.winner];
      this.setData({ winBanner: (winner ? winner.nickName : '有人') + ' 获胜！' });
      return this.gotoResult();
    }
    // 轮到自己 → 提示音
    if (game.currentSeat === this.data.mySeat && this.lastTurnSeat !== game.currentSeat) {
      audio.turn();
    }
    this.lastTurnSeat = game.currentSeat;
    this.maybeTriggerAi();
  },

  // ---------- 视图派生 ----------
  deriveView() {
    const game = this.data.game;
    if (!game) return;
    const app = getApp();
    const roomSeats = this.roomDoc ? this.roomDoc.seats : null;
    const v = view.deriveViewState(game, roomSeats, app.globalData.openId, this.hostedOn,
      this.roomDoc ? this.roomDoc.ownerOpenId : '');
    // v1.16 观战者昵称（战况弹层展示）
    const spectatorNames = [];
    if (this.roomDoc && this.roomDoc.spectators) {
      Object.keys(this.roomDoc.spectators).forEach((k) => {
        const s = this.roomDoc.spectators[k];
        if (s && s.nickName) spectatorNames.push(s.nickName);
      });
    }
    this.setData({
      spectatorNames: spectatorNames,
      mySeat: v.mySeat,
      hostedMe: v.hostedMe,
      playersView: v.playersView,
      canRoll: v.canRoll,
      canSelect: v.canSelect,
      canReroll: v.canReroll,
      heldItems: v.heldItems,
      hintText: v.hintText
    });

    // 托管接管提示（掉线托管 / 主动托管进入页面时告知一次）
    if (v.hostedMe && v.mySeat >= 0 && !this.hostGreeted) {
      this.hostGreeted = true;
      wx.showToast({
        title: this.hostedOn ? '托管中，AI 代你行动' : '检测到托管，AI 正代你行动',
        icon: 'none',
        duration: 2400
      });
    }
  },
  // ---------- 表情互动 / 托管 / 战况 ----------
  processEmotes(doc) {
    const emotes = doc.emotes || [];
    if (!emotes.length) return;
    const latest = emotes[emotes.length - 1];
    if (this.lastEmoteTs === null || this.lastEmoteTs === undefined) {
      this.lastEmoteTs = latest.ts; // 首次快照只对齐水位，不播历史
      return;
    }
    if (latest.ts <= this.lastEmoteTs) return;
    this.lastEmoteTs = latest.ts;
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
    this.setData({ bubble: { key: latest.ts, from: latest.from || '', type: latest.type } });
    this.bubbleTimer = setTimeout(() => {
      this.bubbleTimer = null;
      this.setData({ bubble: '' });
    }, 3000);
  },

  // 气泡统一出口（v1.8 抽取，3 秒自动消失）
  showBubble(text) {
    this.setData({ bubble: { key: 'b' + Date.now(), from: '', type: text } });
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
    this.bubbleTimer = setTimeout(() => {
      this.bubbleTimer = null;
      this.setData({ bubble: '' });
    }, 3000);
  },

  onEmote(e) {
    // v1.4 客户端冷却倒计时与服务端限频（3 秒）对齐
    if (this.data.emoteCd) return;
    const type = e.currentTarget.dataset.type;
    if (!this.roomId) return;
    api.sendEmote(this.roomId, type).catch(() => { });
    let remain = 3;
    this.setData({ emoteCd: true, emoteCdSec: remain });
    if (this.emoteCdTimer) clearInterval(this.emoteCdTimer);
    this.emoteCdTimer = setInterval(() => {
      remain -= 1;
      if (remain <= 0) {
        clearInterval(this.emoteCdTimer);
        this.emoteCdTimer = null;
        this.setData({ emoteCd: false, emoteCdSec: 0 });
      } else {
        this.setData({ emoteCdSec: remain });
      }
    }, 1000);
    try { wx.vibrateShort({ type: 'light' }); } catch (err) { /* 忽略 */ }
  },

  onToggleHosted() {
    if (this.data.mySeat < 0 || !this.roomId) return;
    const next = !this.hostedOn;
    this.hostedOn = next;
    this.setData({ hostedOn: next });
    // 立即生效：带 hosted 参数的心跳同时更新服务端托管标记
    api.heartbeat(this.roomId, next).catch(() => { });
    wx.showToast({ title: next ? '已托管，AI 代走' : '已接管', icon: 'none' });
    this.deriveView();
  },

  onShowStats() {
    this.setData({ showStats: true });
  },

  onCloseStats() {
    this.setData({ showStats: false });
  },

  onShowRules() {
    this.setData({ showRules: true });
  },

  onCloseRules() {
    this.setData({ showRules: false });
  },

  noop() { },

  // ---------- 玩家操作 ----------
  onRoll() {
    if (!this.data.canRoll || this.rolling) return;
    this.rolling = true;
    api.sendAction(this.gameId, 'ROLL')
      .catch((e) => {
        this.rolling = false;
        if (e.code === 'NOT_YOUR_TURN') return;
        if (e.code === 'GAME_ENDED') return this.gotoResult();
        if (e.code === 'SEQ_CONFLICT') return this.refetch();
        cloudFn.toastErr(e);
      });
  },

  onPlaneTap(e) {
    if (!this.data.canSelect) return;
    const planeId = e.detail.planeId;
    this.setData({ canSelect: false });
    api.sendAction(this.gameId, 'SELECT_PLANE', { planeId: planeId })
      .catch((err) => {
        if (err.code === 'PLANE_NOT_MOVABLE' || err.code === 'NOT_YOUR_TURN') {
          return this.refetch();
        }
        if (err.code === 'GAME_ENDED') return this.gotoResult();
        if (err.code === 'SEQ_CONFLICT') return this.refetch();
        cloudFn.toastErr(err);
      });
  },

  // v1.18 观战者接管 AI 座位
  onTakeover(e) {
    const seatIdx = e.currentTarget.dataset.seat;
    if (seatIdx === undefined || !this.roomId) return;
    api.seatAction(this.roomId, seatIdx, 'takeover')
      .then(() => wx.showToast({ title: '接管成功，轮到你时即可行动', icon: 'none' }))
      .catch((err) => cloudFn.toastErr(err));
  },

  // v1.12 房号一键复制
  onCopyRoomNo() {
    if (!this.data.roomNo) return;
    wx.setClipboardData({
      data: this.data.roomNo,
      success: () => wx.showToast({ title: '房号已复制', icon: 'success' })
    });
  },

  // v1.6 重掷道具
  onReroll() {
    if (!this.data.canReroll || this.rerolling) return;
    this.rerolling = true;
    api.sendAction(this.gameId, 'USE_ITEM', { item: 'reroll' })
      .catch((err) => {
        if (err.code === 'NO_ITEM' || err.code === 'ILLEGAL_ACTION' || err.code === 'NOT_YOUR_TURN') {
          return this.refetch();
        }
        if (err.code === 'GAME_ENDED') return this.gotoResult();
        if (err.code === 'SEQ_CONFLICT') return this.refetch();
        cloudFn.toastErr(err);
      });
  },

  refetch() {
    api.fetchGame(this.gameId).then((doc) => {
      if (!doc) return;
      if (doc.status === 'finished') return this.gotoResult();
      this.queue.push(doc);
      this.processQueue();
    }).catch(() => { });
  },

  onToggleMute() {
    const enabled = audio.toggle();
    this.setData({ muted: !enabled });
  },

  onExit() {
    const playing = this.data.game && this.data.game.status === 'playing';
    const doExit = () => {
      if (playing && this.data.mySeat >= 0) {
        api.leaveRoom(this.roomId).catch(() => { });
      }
      wx.reLaunch({ url: '/pages/hall/hall' });
    };
    if (!playing) return doExit();
    wx.showModal({
      title: '离开对局',
      content: '离开后你的座位将由 AI 托管代走，随时可以回来接管。',
      confirmText: '离开',
      success: (res) => { if (res.confirm) doExit(); }
    });
  },

  // ---------- 分享 ----------
  onShareAppMessage() {
    return {
      title: '飞行棋战况正酣，来围观或下一局！',
      path: this.roomId
        ? '/pages/hall/hall?roomId=' + this.roomId
        : '/pages/hall/hall'
    };
  }
});
