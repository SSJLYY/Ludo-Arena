// 大厅：创建房间 / 加入房间 / 快速开始 / 继续上局 / 分享直达
const api = require('../../services/api.js');
const cloudFn = require('../../utils/cloud.js');
const tiers = require('../../engine/tiers.js');

const AI_LEVELS = ['简单', '普通', '困难', '大师'];

Page({
  data: {
    profile: { nickName: '', avatarUrl: '' },
    lastRoom: null,            // {roomId, roomNo, status}
    showCreate: false,
    creating: false,
    aiLevels: AI_LEVELS,
    form: {
      hasPassword: false,
      password: '',
      aiLevelIndex: 1,          // 默认普通
      exactFinish: true,
      flyArrow: true,           // v1.1 飞行箭头
      allowItems: true          // v1.6 道具卡
    },
    joinNo: '',
    joinPwd: '',
    needPwd: false,
    joinRoomId: '',             // 分享直达时记录
    // v1.3 排行榜
    showLeaderboard: false,
    lbLoading: false,
    lbRows: [],
    lbMe: null,
    lbMyRank: 0,
    // v1.3 首次引导
    showGuide: false
  },

  onLoad(options) {
    // 分享卡片 / 小程序码一步进房
    let roomId = options && options.roomId;
    if (!roomId && options && options.scene) {
      roomId = decodeURIComponent(options.scene);
    }
    if (roomId) {
      this.setData({ joinRoomId: roomId });
      this.autoJoin(roomId);
    }
  },

  onShow() {
    this.refreshProfile();
    this.refreshLastRoom();
    this.maybeShowGuide();
    this.showCloudErrorOnce();
  },

  // v1.3 首次进入引导（只弹一次）
  maybeShowGuide() {
    if (this.data.showGuide) return;
    let seen = false;
    try { seen = wx.getStorageSync('fc_guide_seen') === '1'; } catch (e) { /* 忽略 */ }
    this.setData({ showGuide: !seen });
  },

  // v1.19.3 云调用失败时弹一次真实原因（部署期诊断）
  showCloudErrorOnce() {
    if (this.cloudErrShown) return;
    const msg = getApp().globalData.cloudError;
    if (!msg) return;
    this.cloudErrShown = true;
    wx.showModal({
      title: '云服务连接失败',
      content: msg + '\n\n请按 README「快速开始」完成：① 开通云开发 ② 部署 12 个云函数 ③ 创建 5 个集合',
      showCancel: false
    });
  },
  onCloseGuide() {
    try { wx.setStorageSync('fc_guide_seen', '1'); } catch (e) { /* 忽略 */ }
    this.setData({ showGuide: false });
  },

  refreshProfile() {
    const app = getApp();
    const apply = () => this.setData({ profile: app.globalData.profile || {} });
    apply();
    if (!app.globalData.profileReady) {
      app.fetchProfile().then(apply).catch(apply);
    }
  },

  refreshLastRoom() {
    const app = getApp();
    if (!app.globalData.openId) {
      app.fetchProfile().then(() => this.refreshLastRoom()).catch(() => { });
      return;
    }
    api.fetchUser(app.globalData.openId).then((user) => {
      if (!user || !user.lastRoomId) return;
      return api.fetchRoom(user.lastRoomId).then((room) => {
        if (room && (room.status === 'waiting' || room.status === 'playing')) {
          this.setData({
            lastRoom: { roomId: room._id, roomNo: room.roomNo, status: room.status }
          });
        } else {
          this.setData({ lastRoom: null });
        }
      });
    }).catch(() => { });
  },

  goLastRoom() {
    const last = this.data.lastRoom;
    if (!last) return;
    wx.redirectTo({ url: '/pages/room/room?roomId=' + last.roomId });
  },

  goMine() {
    wx.navigateTo({ url: '/pages/mine/mine' });
  },

  // ---------- 快速开始：1 人 + 3 AI 直接开局 ----------
  quickStart() {
    if (this.data.creating) return;
    this.setData({ creating: true });
    const app = getApp();
    api.createRoom({ quick: true, profile: app.globalData.profile })
      .then((res) => api.startGame(res.roomId))
      .then((res) => {
        wx.redirectTo({ url: '/pages/game/game?gameId=' + res.gameId });
      })
      .catch((e) => cloudFn.toastErr(e, '开局失败，请重试'))
      .then(() => this.setData({ creating: false }));
  },

  // ---------- 创建房间 ----------
  openCreate() {
    this.setData({ showCreate: true });
  },

  closeCreate() {
    this.setData({ showCreate: false });
  },

  noop() { },

  onFormToggle(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['form.' + field]: e.detail.value });
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['form.' + field]: e.detail.value });
  },

  onAiLevel(e) {
    this.setData({ 'form.aiLevelIndex': Number(e.detail.value) });
  },

  confirmCreate() {
    if (this.data.creating) return;
    const form = this.data.form;
    if (form.hasPassword && !form.password) {
      wx.showToast({ title: '请输入房间密码', icon: 'none' });
      return;
    }
    this.setData({ creating: true });
    const app = getApp();
    api.createRoom({
      password: form.hasPassword ? form.password : '',
      settings: {
        needExactFinish: form.exactFinish,
        allowFly: form.flyArrow,
        allowItems: form.allowItems,
        aiLevel: form.aiLevelIndex + 1
      },
      profile: app.globalData.profile
    }).then((res) => {
      this.setData({ showCreate: false });
      wx.redirectTo({ url: '/pages/room/room?roomId=' + res.roomId });
    }).catch((e) => {
      cloudFn.toastErr(e, '创建失败，请重试');
    }).then(() => this.setData({ creating: false }));
  },

  // ---------- 加入房间 ----------
  onJoinNo(e) { this.setData({ joinNo: e.detail.value }); },
  onJoinPwd(e) { this.setData({ joinPwd: e.detail.value }); },

  joinByNo() {
    const no = (this.data.joinNo || '').trim();
    if (!/^\d{6}$/.test(no)) {
      wx.showToast({ title: '请输入 6 位数字房号', icon: 'none' });
      return;
    }
    this.doJoin({ roomNo: no, password: this.data.joinPwd });
  },

  autoJoin(roomId) {
    this.doJoin({ roomId: roomId });
  },

  doJoin(payload) {
    const app = getApp();
    const go = () => {
      api.joinRoom(Object.assign({ profile: app.globalData.profile }, payload))
        .then((res) => {
          // v1.16 清除密码输入状态，避免下次进入大厅残留
          this.setData({ needPwd: false, joinPwd: '', joinRoomId: '' });
          wx.redirectTo({ url: '/pages/room/room?roomId=' + res.roomId });
        })
        .catch((e) => {
          if (e.code === 'WRONG_PASSWORD' || e.code === 'LOCKED') {
            // v1.17 无论房号来源（分享 roomId / 手输 roomNo），密码错误都展开密码输入
            this.setData({ needPwd: true });
            cloudFn.toastErr(e);
          } else {
            cloudFn.toastErr(e);
          }
        });
    };
    if (app.globalData.profileReady) go();
    else app.fetchProfile().then(go).catch(go);
  },

  // v1.3 房号粘贴快速填入
  onPasteRoomNo() {
    wx.getClipboardData({
      success: (res) => {
        const m = String(res.data || '').match(/\d{6}/);
        if (m) {
          this.setData({ joinNo: m[0] });
          wx.showToast({ title: '已填入房号 ' + m[0], icon: 'none' });
        } else {
          wx.showToast({ title: '剪贴板里没有 6 位房号', icon: 'none' });
        }
      },
      fail: () => wx.showToast({ title: '读取剪贴板失败', icon: 'none' })
    });
  },

  // ---------- v1.3 排行榜 ----------
  onShowLeaderboard() {
    this.setData({ showLeaderboard: true, lbLoading: true, lbRows: [], lbMe: null, lbMyRank: 0 });
    api.getLeaderboard().then((res) => {
      const rows = (res.rows || []).map((r) => Object.assign({}, r, {
        tierName: tiers.tierOf(r.wins || 0).name
      }));
      this.setData({ lbRows: rows, lbMe: res.me || null, lbMyRank: res.myRank || 0, lbLoading: false });
    }).catch((e) => {
      this.setData({ lbLoading: false });
      cloudFn.toastErr(e, '排行榜加载失败');
    });
  },

  onCloseLeaderboard() {
    this.setData({ showLeaderboard: false });
  },

  // ---------- 转发 ----------
  onShareAppMessage() {
    return {
      title: '飞行棋，4 人开黑，快来战一局！',
      path: '/pages/hall/hall'
    };
  },

  onShareTimeline() {
    return { title: '飞行棋，4 人开黑，快来战一局！' };
  }
});
