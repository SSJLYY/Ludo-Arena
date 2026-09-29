// 战绩页：排名 + 统计 + 分享海报（Canvas 生成，零图片资源）
const api = require('../../services/api.js');
const sync = require('../../services/sync.js');
const cloudFn = require('../../utils/cloud.js');
const achievements = require('../../engine/achievements.js');

const COLOR_HEX = ['#e5484d', '#f0a12a', '#3f7bf5', '#27ae60'];
const COLOR_NAMES = ['红方', '黄方', '蓝方', '绿方'];
const MEDALS = ['🥇', '🥈', '🥉', '4️⃣'];

Page({
  data: {
    game: null,
    rows: [],
    myRank: 0,
    isOwner: false,
    roomId: '',
    roomStatus: '',
    durationText: '',
    newAchievements: [],
    showConfetti: false,
    posterReady: false,
    showPoster: false,
    posterTitle: ''
  },

  onLoad(options) {
    this.gameId = options && options.gameId;
    if (!this.gameId) return wx.reLaunch({ url: '/pages/hall/hall' });
    this.load();
  },

  // v1.4 对局时长（创建 → 终局）
  formatDuration(sec) {
    if (!(sec > 0)) return '';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m === 0) return s + ' 秒';
    return m + ' 分 ' + (s > 0 ? s + ' 秒' : '');
  },

  load() {
    api.fetchGame(this.gameId).then((game) => {
      if (!game) return wx.reLaunch({ url: '/pages/hall/hall' });
      const app = getApp();
      const ranking = game.ranking && game.ranking.length ? game.ranking : [game.winner];
      const rows = ranking.map((seat, i) => {
        const p = game.players[seat];
        return {
          rank: i + 1,
          medal: MEDALS[i] || String(i + 1),
          color: COLOR_HEX[seat],
          colorName: COLOR_NAMES[seat],
          name: p.nickName || COLOR_NAMES[seat],
          avatar: p.avatarUrl || '',
          isAI: p.type === 'ai',
          finished: p.finishedCount,
          kills: p.stats.kills,
          rolls: p.stats.rolls,
          sixes: p.stats.sixes,
          progress: p.finishedCount === 4 ? '全部到达' : '进度 ' +
            p.planes.reduce((s, pl) => s + (pl.state === 'base' ? 0 : pl.rp), 0) + '/228'
        };
      });
      const mySeat = game.players.findIndex(
        (p) => p.type === 'human' && p.openId === app.globalData.openId);
      const durationSec = Math.round(((game.updatedAt || 0) - (game.createdAt || 0)) / 1000);
      this.setData({
        game: game,
        rows: rows,
        myRank: mySeat >= 0 ? ranking.indexOf(mySeat) + 1 : 0,
        roomId: game.roomId,
        durationText: this.formatDuration(durationSec),
        posterTitle: mySeat >= 0 ? this.rankText(ranking.indexOf(mySeat) + 1) : '战况速览'
      });
      // v1.7 冠军彩带
      if (this.data.myRank === 1) this.startConfetti();
      // v1.5 本局解锁的新成就（结算时写入最近对局记录）
      if (mySeat >= 0) {
        api.fetchUser(app.globalData.openId).then((user) => {
          const entry = ((user && user.recentGames) || []).find((g) => g.gameId === this.gameId);
          const ids = (entry && entry.newAchievements) || [];
          this.setData({
            newAchievements: ids.map((id) => {
              const d = achievements.find(id);
              return d ? { id: id, icon: d.icon, name: d.name } : null;
            }).filter(Boolean)
          });
        }).catch(() => { });
      }
      if (game.roomId) {
        api.fetchRoom(game.roomId).then((room) => {
          this.setData({
            isOwner: room && room.ownerOpenId === app.globalData.openId,
            roomStatus: room ? room.status : ''
          });
        }).catch(() => { });
        // 房主点了「再来一局」→ 房间状态变 playing → 全员自动进入新对局
        this.roomWatcher = sync.watchDoc('rooms', game.roomId, (room) => {
          if (room && room.status === 'playing' && room.gameId && room.gameId !== this.gameId) {
            if (this.roomWatcher) { this.roomWatcher.close(); this.roomWatcher = null; }
            wx.redirectTo({ url: '/pages/game/game?gameId=' + room.gameId });
          } else if (room) {
            this.setData({ roomStatus: room.status });
          }
        });
      }
      this.drawPoster().catch(() => { });
    }).catch(() => wx.reLaunch({ url: '/pages/hall/hall' }));
  },

  onUnload() {
    this.confettiOn = false;
    if (this.roomWatcher) { this.roomWatcher.close(); this.roomWatcher = null; }
  },

  rankText(rank) {
    if (rank === 1) return '🏆 冠军！';
    if (rank === 2) return '🥈 亚军';
    if (rank === 3) return '🥉 季军';
    return '第 ' + rank + ' 名';
  },

  // ---------- 再来一局 / 返回 ----------
  onAgain() {
    if (!this.data.roomId) return;
    api.startGame(this.data.roomId)
      .then((res) => wx.redirectTo({ url: '/pages/game/game?gameId=' + res.gameId }))
      .catch((e) => cloudFn.toastErr(e));
  },

  onBackRoom() {
    if (!this.data.roomId) return wx.reLaunch({ url: '/pages/hall/hall' });
    wx.redirectTo({ url: '/pages/room/room?roomId=' + this.data.roomId });
  },

  onHome() {
    wx.reLaunch({ url: '/pages/hall/hall' });
  },

  // v1.7 冠军彩带（Canvas 2D 粒子，仅自己夺冠时播放）
  startConfetti() {
    this.confettiOn = true;
    this.setData({ showConfetti: true });
    setTimeout(() => {
      this.createSelectorQuery().select('#confetti').fields({ node: true, size: true }).exec((res) => {
        if (!res || !res[0] || !this.confettiOn) return;
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = wx.getSystemInfoSync().pixelRatio || 2;
        const w = res[0].width;
        const h = res[0].height;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);

        const colors = ['#e5484d', '#f0a12a', '#3f7bf5', '#27ae60', '#ffb03a', '#e8543f'];
        const parts = [];
        for (let i = 0; i < 100; i++) {
          parts.push({
            x: Math.random() * w,
            y: -20 - Math.random() * h * 0.6,
            vx: (Math.random() - 0.5) * 2.4,
            vy: 2 + Math.random() * 3.2,
            size: 5 + Math.random() * 7,
            rot: Math.random() * Math.PI,
            vr: (Math.random() - 0.5) * 0.3,
            color: colors[Math.floor(Math.random() * colors.length)]
          });
        }
        const start = Date.now();
        const step = () => {
          if (!this.confettiOn) return;
          const t = (Date.now() - start) / 1000;
          ctx.clearRect(0, 0, w, h);
          for (const p of parts) {
            p.x += p.vx + Math.sin(t * 3 + p.y * 0.01) * 0.6;
            p.y += p.vy;
            p.rot += p.vr;
            if (p.y > h + 20) { p.y = -20; p.vy = 2 + Math.random() * 3.2; }
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
            ctx.restore();
          }
          if (t < 3.2) {
            if (canvas.requestAnimationFrame) canvas.requestAnimationFrame(step);
            else setTimeout(step, 16);
          } else {
            ctx.clearRect(0, 0, w, h);
            this.setData({ showConfetti: false });
          }
        };
        step();
      });
    }, 100);
  },

  // v1.1 对局回放
  onReplay() {
    wx.navigateTo({ url: '/pages/replay/replay?gameId=' + this.gameId });
  },

  // ---------- 海报 ----------
  ensureCanvas() {
    if (this.canvasNode) return Promise.resolve(this.canvasNode);
    return new Promise((resolve, reject) => {
      this.createSelectorQuery().select('#poster').fields({ node: true }).exec((res) => {
        if (!res || !res[0] || !res[0].node) return reject(new Error('no canvas'));
        this.canvasNode = res[0].node;
        resolve(this.canvasNode);
      });
    });
  },

  async drawPoster() {
    const game = this.data.game;
    if (!game) return;
    const node = await this.ensureCanvas();
    const W = 600;
    const H = 960;
    const dpr = wx.getSystemInfoSync().pixelRatio || 2;
    node.width = W * dpr;
    node.height = H * dpr;
    const ctx = node.getContext('2d');
    ctx.scale(dpr, dpr);

    // 背景
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#2b2c49');
    grad.addColorStop(1, '#171827');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 标题
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 44px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('飞行棋 · 对局战绩', W / 2, 96);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '24px sans-serif';
    ctx.fillText(new Date(game.createdAt || Date.now()).toLocaleDateString(), W / 2, 136);

    // 排名卡片
    const rows = this.data.rows;
    let y = 200;
    for (const r of rows) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      this.roundRect(ctx, 48, y, W - 96, 118, 20);
      ctx.fill();
      // 名次
      ctx.fillStyle = r.rank === 1 ? '#ffb03a' : '#ffffff';
      ctx.font = 'bold 48px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(String(r.rank), 84, y + 78);
      // 色块
      ctx.beginPath();
      ctx.arc(152, y + 59, 22, 0, Math.PI * 2);
      ctx.fillStyle = r.color;
      ctx.fill();
      // 名字 + 数据
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 30px sans-serif';
      ctx.fillText(r.name + (r.isAI ? '（AI）' : ''), 196, y + 50);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '22px sans-serif';
      ctx.fillText('击落 ' + r.kills + ' · 掷骰 ' + r.rolls + ' · ' + r.progress, 196, y + 88);
      y += 138;
    }

    // 小程序码（best-effort）
    if (game.roomId) {
      try {
        const res = await cloudFn.call('getWxacode', { roomId: game.roomId });
        if (res && res.fileID) {
          const tmp = await wx.cloud.getTempFileURL({ fileList: [res.fileID] });
          const url = tmp.fileList && tmp.fileList[0] && tmp.fileList[0].tempFileURL;
          if (url) {
            const img = node.createImage();
            await new Promise((resolve, reject) => {
              img.onload = resolve;
              img.onerror = reject;
              img.src = url;
            });
            const size = 132;
            ctx.fillStyle = '#ffffff';
            this.roundRect(ctx, W - size - 48, H - size - 56, size + 16, size + 16, 14);
            ctx.fill();
            ctx.drawImage(img, W - size - 40, H - size - 48, size, size);
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.font = '20px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('扫码一起玩', W - size - 40, H - 34);
          }
        }
      } catch (e) { /* 海报不因小程序码失败而失败 */ }
    }

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('飞行棋 · 微信小程序', W / 2, H - 40);

    // 导出临时文件供分享/保存
    try {
      const path = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas: node,
          success: (r) => resolve(r.tempFilePath),
          fail: reject
        });
      });
      this.posterPath = path;
      this.setData({ posterReady: true });
    } catch (e) { /* 忽略 */ }
  },

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  },

  openPoster() {
    this.setData({ showPoster: true });
  },

  closePoster() {
    this.setData({ showPoster: false });
  },

  savePoster() {
    if (!this.posterPath) return;
    wx.saveImageToPhotosAlbum({
      filePath: this.posterPath,
      success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
      fail: () => {
        wx.showModal({
          title: '需要相册权限',
          content: '请在设置中允许保存图片',
          success: (res) => { if (res.confirm) wx.openSetting(); }
        });
      }
    });
  },

  // ---------- 分享 ----------
  onShareAppMessage() {
    return {
      title: this.data.myRank === 1
        ? '我在飞行棋拿了冠军，来挑战我！'
        : '飞行棋战绩出炉，快来和我战一局！',
      path: this.data.roomId
        ? '/pages/hall/hall?roomId=' + this.data.roomId
        : '/pages/hall/hall',
      imageUrl: this.posterPath || undefined
    };
  },

  // v1.10 朋友圈分享
  onShareTimeline() {
    return {
      title: this.data.myRank === 1
        ? '我在飞行棋拿了冠军，来挑战我！'
        : '飞行棋战绩出炉，快来和我战一局！',
      query: this.data.roomId ? 'roomId=' + this.data.roomId : '',
      imageUrl: this.posterPath || undefined
    };
  }
});
