// 房间：座位管理 / 邀请分享 / AI 配置 / 开局
const api = require('../../services/api.js');
const sync = require('../../services/sync.js');
const cloudFn = require('../../utils/cloud.js');

Page({
  data: {
    roomId: '',
    room: null,
    myOpenId: '',
    isOwner: false,
    isSpectator: false,
    spectatorCount: 0,
    mySeatIndex: -1,
    filledCount: 0,
    startHint: '',
    canStart: false,
    leaving: false,
    redirected: false,
    showPoster: false,
    posterReady: false,
    posterPath: ''
  },

  onLoad(options) {
    const roomId = options && options.roomId;
    if (!roomId) {
      wx.showToast({ title: '房间不存在', icon: 'none' });
      setTimeout(() => wx.reLaunch({ url: '/pages/hall/hall' }), 800);
      return;
    }
    const app = getApp();
    this.setData({ roomId: roomId, myOpenId: app.globalData.openId });
    if (!app.globalData.openId) {
      app.fetchProfile().then(() => this.setData({ myOpenId: app.globalData.openId })).catch(() => { });
    }
    this.startHeartbeat();
    this.loadRoom();
  },

  onUnload() {
    if (this.watcher) this.watcher.close();
    if (this.hbTimer) clearInterval(this.hbTimer);
  },

  startHeartbeat() {
    const beat = () => api.heartbeat(this.data.roomId).catch(() => { });
    beat();
    this.hbTimer = setInterval(beat, 10000);
  },

  loadRoom() {
    api.fetchRoom(this.data.roomId).then((room) => {
      if (!room) return this.onRoomGone();
      this.applyRoom(room);
    }).catch(() => this.onRoomGone());
    // 实时同步座位状态
    this.watcher = sync.watchDoc('rooms', this.data.roomId, (room) => {
      if (!room) return;
      if (room.status === 'dissolved') return this.onRoomGone();
      this.applyRoom(room);
    });
  },

  onRoomGone() {
    wx.showToast({ title: '房间已解散', icon: 'none' });
    setTimeout(() => wx.reLaunch({ url: '/pages/hall/hall' }), 900);
  },

  applyRoom(room) {
    const app = getApp();
    const myOpenId = app.globalData.openId || this.data.myOpenId;
    const mySeatIndex = room.seats.findIndex((s) => s.type === 'human' && s.openId === myOpenId);
    const spectatorMap = room.spectators || {};
    const specList = Object.keys(spectatorMap).map((k) => spectatorMap[k]).filter(Boolean);
    const filledCount = room.seats.filter((s) => s.type !== 'empty').length;
    const isOwner = room.ownerOpenId === myOpenId;
    const isSpectator = mySeatIndex < 0 && specList.some((s) => s.openId === myOpenId);

    // 观战者首次进入提示
    if (isSpectator && !this.spectatorToasted) {
      this.spectatorToasted = true;
      wx.showToast({ title: '座位已满，已进入观战', icon: 'none', duration: 2200 });
    }

    this.setData({
      room: room,
      myOpenId: myOpenId,
      mySeatIndex: mySeatIndex,
      isOwner: isOwner,
      isSpectator: isSpectator,
      specList: specList,
      spectatorCount: room.spectatorCount || specList.length,
      filledCount: filledCount,
      canStart: filledCount === 4 && isOwner,
      startHint: filledCount < 4
        ? '还需 ' + (4 - filledCount) + ' 位玩家'
        : (isOwner ? '一切就绪，可以开局'
        : '等待房主 ' + (room.seats.find((s) => s.type === 'human' && s.openId === room.ownerOpenId) || {}).nickName + ' 开局')
    });

    // 开局后所有人（含观战者）自动进入对局页
    if (room.status === 'playing' && room.gameId && !this.data.redirected) {
      this.setData({ redirected: true });
      wx.redirectTo({ url: '/pages/game/game?gameId=' + room.gameId });
    }
  },

  copyRoomNo() {
    if (!this.data.room) return;
    wx.setClipboardData({
      data: this.data.room.roomNo,
      success: () => wx.showToast({ title: '房号已复制', icon: 'success' })
    });
  },

  // ---------- 座位事件 ----------
  onSit(e) {
    api.seatAction(this.data.roomId, e.detail.index, 'sit')
      .catch((err) => cloudFn.toastErr(err));
  },

  onAddAI(e) {
    api.seatAction(this.data.roomId, e.detail.index, 'addAI')
      .catch((err) => cloudFn.toastErr(err));
  },

  onRemoveAI(e) {
    api.seatAction(this.data.roomId, e.detail.index, 'removeAI')
      .catch((err) => cloudFn.toastErr(err));
  },

  onSetLevel(e) {
    api.seatAction(this.data.roomId, e.detail.index, 'setAiLevel', { aiLevel: e.detail.aiLevel })
      .catch((err) => cloudFn.toastErr(err));
  },

  onKick(e) {
    const seat = this.data.room.seats[e.detail.index];
    wx.showModal({
      title: '移除玩家',
      content: '确定把「' + seat.nickName + '」请出房间吗？',
      confirmColor: '#d43d2a',
      success: (res) => {
        if (res.confirm) {
          api.seatAction(this.data.roomId, e.detail.index, 'kick').catch((err) => cloudFn.toastErr(err));
        }
      }
    });
  },

  // ---------- 开局 / 离开 ----------
  onStart() {
    if (!this.data.canStart || this.leaving) return;
    api.startGame(this.data.roomId)
      .then((res) => {
        this.setData({ redirected: true });
        wx.redirectTo({ url: '/pages/game/game?gameId=' + res.gameId });
      })
      .catch((err) => cloudFn.toastErr(err));
  },

  onLeave() {
    if (this.data.leaving) return;
    this.setData({ leaving: true });
    api.leaveRoom(this.data.roomId)
      .then(() => wx.reLaunch({ url: '/pages/hall/hall' }))
      .catch((err) => {
        cloudFn.toastErr(err);
        this.setData({ leaving: false });
      });
  },

  // ---------- 分享 ----------
  onShareAppMessage() {
    const room = this.data.room;
    const roomNo = room ? room.roomNo : '';
    return {
      title: '我开了飞行棋房间，房号 ' + roomNo + '，来战！',
      path: '/pages/hall/hall?roomId=' + this.data.roomId,
      imageUrl: this.data.posterPath || undefined
    };
  },

  // ---------- v1.10 邀请海报 ----------
  onInvitePoster() {
    if (this.data.posterReady && this.data.posterPath) {
      return this.setData({ showPoster: true });
    }
    wx.showLoading({ title: '生成海报…', mask: true });
    this.drawPoster().then(() => {
      wx.hideLoading();
      this.setData({ showPoster: true, posterReady: true });
    }).catch((e) => {
      wx.hideLoading();
      cloudFn.toastErr(e, '海报生成失败，请重试');
    });
  },

  closePoster() {
    this.setData({ showPoster: false });
  },

  noop() { },

  ensurePosterCanvas() {
    if (this.posterCanvas) return Promise.resolve(this.posterCanvas);
    return new Promise((resolve, reject) => {
      this.createSelectorQuery().select('#invitePoster').fields({ node: true }).exec((res) => {
        if (!res || !res[0] || !res[0].node) return reject(new Error('no canvas'));
        this.posterCanvas = res[0].node;
        resolve(this.posterCanvas);
      });
    });
  },

  // 邀请海报：房号 + 座位状态 + 小程序码（零图片资源，canvas 全绘制）
  async drawPoster() {
    const room = this.data.room;
    if (!room) throw new Error('no room');
    const node = await this.ensurePosterCanvas();
    const W = 600;
    const H = 900;
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

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 46px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('飞行棋', W / 2, 110);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '24px sans-serif';
    ctx.fillText('4 人开黑 · 扫码即战', W / 2, 152);

    // 房号卡片
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    this.roundRect(ctx, 60, 210, W - 120, 170, 22);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '24px sans-serif';
    ctx.fillText('房间号', W / 2, 258);
    ctx.fillStyle = '#ffb03a';
    ctx.font = 'bold 84px sans-serif';
    ctx.fillText(room.roomNo, W / 2, 348);

    // 座位状态
    const hexMap = { red: '#e5484d', yellow: '#f0a12a', blue: '#3f7bf5', green: '#27ae60' };
    let y = 440;
    for (const s of room.seats) {
      if (s.type === 'empty') continue;
      ctx.beginPath();
      ctx.arc(110, y - 10, 12, 0, Math.PI * 2);
      ctx.fillStyle = hexMap[s.color];
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 28px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(s.nickName, 140, y);
      y += 64;
    }
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '22px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('已就座 ' + this.data.filledCount + '/4 · 观战 ' + this.data.spectatorCount + ' 人', 110, y + 6);

    // 小程序码（best-effort，失败则画引导文案）
    let qrDrawn = false;
    try {
      const qrRes = await cloudFn.call('getWxacode', { roomId: this.data.roomId });
      if (qrRes && qrRes.fileID) {
        const tmp = await wx.cloud.getTempFileURL({ fileList: [qrRes.fileID] });
        const url = tmp.fileList && tmp.fileList[0] && tmp.fileList[0].tempFileURL;
        if (url) {
          const img = node.createImage();
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = url;
          });
          const size = 168;
          ctx.fillStyle = '#ffffff';
          this.roundRect(ctx, W - size - 52, H - size - 76, size + 16, size + 16, 16);
          ctx.fill();
          ctx.drawImage(img, W - size - 44, H - size - 68, size, size);
          qrDrawn = true;
        }
      }
    } catch (e) { /* 无码时降级 */ }
    if (!qrDrawn) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '22px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('微信搜索房号 ' + room.roomNo + ' 加入', W / 2, H - 96);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('扫码 / 搜索房号，直接进房开战', W / 2, H - 44);

    // 导出临时文件（转发分享图复用）
    const path = await new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas: node,
        success: (r) => resolve(r.tempFilePath),
        fail: reject
      });
    });
    this.setData({ posterPath: path, posterReady: true });
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

  savePoster() {
    if (!this.data.posterPath) return;
    wx.saveImageToPhotosAlbum({
      filePath: this.data.posterPath,
      success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
      fail: () => {
        wx.showModal({
          title: '需要相册权限',
          content: '请在设置中允许保存图片',
          success: (res) => { if (res.confirm) wx.openSetting(); }
        });
      }
    });
  }
});
