// 对局回放：从 moves 流水重建每一帧状态，复用 chess-board 播放动画
const move = require('../../engine/move.js');
const replayEngine = require('../../engine/replay.js');
const api = require('../../services/api.js');

const COLOR_HEX = ['#e5484d', '#f0a12a', '#3f7bf5', '#27ae60'];
const COLOR_NAMES = ['红方', '黄方', '蓝方', '绿方'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Page({
  data: {
    loading: true,
    boardSize: 340,
    showFly: true,
    total: 0,
    index: 0,
    currentSeat: -1,
    playing: false,
    ended: false,
    speed: 1,
    diceVal: 1,
    actorName: '',
    highlights: [],
    showHighlights: false,
    highlightsOpen: false,
    playersView: [],
    winnerName: ''
  },

  onLoad(options) {
    this.gameId = options && options.gameId;
    if (!this.gameId) return wx.reLaunch({ url: '/pages/hall/hall' });
    this.frames = [];
    this.playing = false;

    // v1.11 回放速度记忆
    let savedSpeed = 1;
    try { savedSpeed = Number(wx.getStorageSync('fc_replay_speed')) || 1; } catch (e) { /* 忽略 */ }
    if ([1, 2, 4].indexOf(savedSpeed) < 0) savedSpeed = 1;

    const info = wx.getSystemInfoSync();
    this.setData({
      speed: savedSpeed,
      boardSize: Math.max(280, Math.min(info.windowWidth - 32, info.windowHeight - 420, 430))
    });
    this.load();
  },

  onUnload() {
    this.playing = false;
  },

  // v1.12 分享回放：好友点开直接看这一局的完整回放
  onShareAppMessage() {
    return {
      title: '回放：这局飞行棋对局太精彩了！',
      path: '/pages/replay/replay?gameId=' + this.gameId
    };
  },

  onShareTimeline() {
    return {
      title: '回放：这局飞行棋对局太精彩了！',
      query: 'gameId=' + this.gameId
    };
  },

  async load() {
    try {
      const game = await api.fetchGame(this.gameId);
      if (!game) return this.onGone();
      const moves = await api.fetchMoves(this.gameId);
      if (!moves || !moves.length) {
        wx.showToast({ title: '该对局没有回放数据', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 900);
        return;
      }
      this.frames = this.buildFrames(game, moves);
      this.extractHighlights();
      this.setData({
        loading: false,
        total: this.frames.length,
        showFly: game.allowFly !== false,
        playersView: game.players.map((p, i) => ({
          seat: i,
          color: COLOR_HEX[i],
          name: p.nickName || COLOR_NAMES[i],
          avatar: p.avatarUrl || '',
          done: p.finishedCount
        })),
        winnerName: game.winner !== null && game.winner !== undefined
          ? (game.players[game.winner] || {}).nickName || COLOR_NAMES[game.winner]
          : ''
      });
      // 等棋盘组件就绪后落到第一帧
      await sleep(150);
      await this.showFrame(0, false);
    } catch (e) {
      this.onGone();
    }
  },

  onGone() {
    wx.showToast({ title: '对局不存在', icon: 'none' });
    setTimeout(() => wx.navigateBack(), 900);
  },

  // v1.19 关键时刻书签：从帧事件提取击杀/飞跃/胜利时刻
  extractHighlights() {
    const highlights = [];
    const players = this.data.playersView;
    this.frames.forEach((f, idx) => {
      for (const ev of (f.events || [])) {
        if (ev.type !== 'move') continue;
        const kills = (ev.kills || []).filter((k) => !k.blocked);
        if (kills.length > 0) {
          const actor = players[ev.seat] ? players[ev.seat].name : '';
          const victims = kills.map((k) => players[k.seat] ? players[k.seat].name : '?').join('、');
          highlights.push({ idx: idx, icon: '💥',
            text: actor + ' 击落 ' + victims + (kills.length > 1 ? '（叠子！）' : '') });
          break;
        }
        if (ev.fly !== null && ev.fly !== undefined) {
          const actor = players[ev.seat] ? players[ev.seat].name : '';
          highlights.push({ idx: idx, icon: '🚀', text: actor + ' 飞行箭头飞跃 12 格' });
          break;
        }
        if (ev.win) {
          const actor = players[ev.seat] ? players[ev.seat].name : '';
          highlights.push({ idx: idx, icon: '🏆', text: actor + ' 4 机到齐获胜' });
          break;
        }
      }
    });
    // 只保留最近 12 条（长对局书签过多）
    const trimmed = highlights.slice(-12);
    this.setData({ highlights: trimmed, showHighlights: trimmed.length > 0 });
  },

  onJumpHighlight(e) {
    const idx = e.currentTarget.dataset.idx;
    if (idx === undefined) return;
    this.stopPlay();
    this.jumpToFrame(Number(idx));
  },

  onToggleHighlights() {
    this.setData({ highlightsOpen: !this.data.highlightsOpen });
  },
  // 由 moves 流水逐帧重建状态快照（共享实现：engine/replay.js）
  buildFrames(game, moves) {
    return replayEngine.buildFrames(game, moves);
  },
  // 播放一帧：1x 全动画；2x/4x 直接跳帧
  async showFrame(i, animate) {
    const f = this.frames[i];
    if (!f) return;
    const board = this.selectComponent('#board');
    if (animate && this.data.speed === 1 && board) {
      const rollEv = f.events.find((e) => e.type === 'roll');
      const dice = this.selectComponent('#dice');
      if (rollEv && dice) await dice.rollTo(rollEv.dice);
      await board.playSnapshot({ seq: f.seq + 1, events: f.events, players: f.state.players });
    } else if (board) {
      board.jumpTo({ seq: f.seq + 1, players: f.state.players });
    }
    this.setData({
      index: i,
      diceVal: f.dice,
      currentSeat: f.state.currentSeat,
      actorName: this.data.playersView[f.state.currentSeat] ?
        this.data.playersView[f.state.currentSeat].name : '',
      diceHistory: this.frames.slice(Math.max(0, i - 7), i + 1).map((fr) => fr.dice),
      ended: i >= this.data.total - 1
    });
  },

  // ---------- 播放控制 ----------
  onTogglePlay() {
    if (this.data.playing) {
      this.playing = false;
      this.setData({ playing: false });
      return;
    }
    if (this.data.index >= this.data.total - 1) {
      this.jumpToFrame(0); // 播完再点 → 重头播
    }
    this.playing = true;
    this.setData({ playing: true });
    this.playLoop();
  },

  async playLoop() {
    while (this.playing) {
      const next = this.data.index + 1;
      if (next >= this.data.total) {
        this.playing = false;
        this.setData({ playing: false });
        break;
      }
      await this.showFrame(next, true);
      if (!this.playing) break;
      await sleep(this.data.speed > 1 ? Math.round(200 / this.data.speed) : 200);
    }
  },

  onPrev() {
    this.stopPlay();
    this.jumpToFrame(this.data.index - 1);
  },

  onNext() {
    this.stopPlay();
    this.jumpToFrame(this.data.index + 1);
  },

  onSlider(e) {
    this.stopPlay();
    this.jumpToFrame(Number(e.detail.value));
  },

  onSpeed() {
    const speeds = this.data.speed === 1 ? 2 : (this.data.speed === 2 ? 4 : 1);
    this.setData({ speed: speeds });
    try { wx.setStorageSync('fc_replay_speed', String(speeds)); } catch (e) { /* 忽略 */ }
  },

  stopPlay() {
    this.playing = false;
    if (this.data.playing) this.setData({ playing: false });
  },

  async jumpToFrame(k) {
    const total = this.data.total;
    if (total === 0) return;
    const clamped = Math.max(0, Math.min(total - 1, k));
    await this.showFrame(clamped, false);
  },

  goBack() {
    wx.navigateBack();
  }
});
