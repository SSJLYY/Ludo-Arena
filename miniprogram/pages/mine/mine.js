// 我的：头像昵称填写（合规组件）+ 战绩统计 + 成就墙 + 玩法说明
const api = require('../../services/api.js');
const rulesText = require('../../utils/rules-text.js');
const achievements = require('../../engine/achievements.js');
const tiers = require('../../engine/tiers.js');

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return s + ' 秒';
  return m + ' 分 ' + (s > 0 ? s + ' 秒' : '');
}

Page({
  data: {
    profile: { nickName: '', avatarUrl: '' },
    stats: null,
    bestKills: 0,
    winStreak: 0,
    achievementWall: [],
    recentGames: [],
    rules: rulesText.RULES,
    saving: false
  },

  onShow() {
    this.setData({ version: (getApp().globalData && getApp().globalData.version) || '' });
    const app = getApp();
    const apply = () => this.setData({ profile: app.globalData.profile || {} });
    apply();
    if (!app.globalData.profileReady) app.fetchProfile().then(apply).catch(apply);
    this.loadStats();
  },

  loadStats() {
    const app = getApp();
    if (!app.globalData.openId) {
      setTimeout(() => this.loadStats(), 800);
      return;
    }
    api.fetchUser(app.globalData.openId).then((user) => {
      const unlocked = {};
      ((user && user.achievements) || []).forEach((id) => { unlocked[id] = true; });
      const achievementWall = achievements.DEFINITIONS.map((d) => ({
        id: d.id, icon: d.icon, name: d.name, desc: d.desc, unlocked: !!unlocked[d.id]
      }));
      const recent = ((user && user.recentGames) || []).map((g) => {
        const d = new Date(g.ts || Date.now());
        return Object.assign({}, g, {
          dateStr: (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
            ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2),
          durationText: g.durationSec ? formatDuration(g.durationSec) : ''
        });
      });
      const stats = user && user.stats ? user.stats : { games: 0, wins: 0, kills: 0 };
    const winRate = stats.games > 0 ? Math.round(stats.wins * 100 / stats.games) : 0;
    this.setData({
        stats: stats,
        winRate: winRate,
        bestKills: (user && user.stats && user.stats.bestKills) || 0,
        winStreak: (user && user.winStreak) || 0,
        tierName: tiers.tierOf((user && user.stats && user.stats.wins) || 0).name,
        tierNext: (function () {
          const n = tiers.winsToNext((user && user.stats && user.stats.wins) || 0);
          return n > 0 ? '再胜 ' + n + ' 场升入' +
            tiers.tierOf(((user && user.stats && user.stats.wins) || 0) + n).name : '已达最高段位';
        })(),
        achievementWall: achievementWall,
        wallCount: achievementWall.filter((a) => a.unlocked).length,
        recentGames: recent
      });
    }).catch(() => { });
  },

  // 微信头像昵称填写能力（合规要求）
  // v1.4：上传失败自动重试一次，仍失败才降级本地临时路径
  onChooseAvatar(e) {
    const tempPath = e.detail && e.detail.avatarUrl;
    if (!tempPath) return;
    const openId = getApp().globalData.openId || 'anon';
    const cloudPath = 'avatar/' + openId + '-' + Date.now() + '.png';
    wx.showLoading({ title: '上传中…', mask: true });
    const upload = (retried) => {
      wx.cloud.uploadFile({
        cloudPath: cloudPath,
        filePath: tempPath,
        success: (res) => {
          wx.hideLoading();
          this.save({ avatarUrl: res.fileID });
        },
        fail: () => {
          if (!retried) return upload(true); // 重试一次
          wx.hideLoading();
          this.save({ avatarUrl: tempPath });
        }
      });
    };
    upload(false);
  },

  onNickInput(e) {
    this.setData({ 'profile.nickName': e.detail.value });
  },

  onNickBlur(e) {
    const name = (e.detail.value || '').trim();
    if (!name || name === this.data.profile.nickName) return;
    this.save({ nickName: name.slice(0, 20) });
  },

  save(patch) {
    if (this.data.saving) return;
    this.setData({ saving: true });
    getApp().saveProfile(patch).then(() => {
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ profile: getApp().globalData.profile });
    }).catch(() => {
      wx.showToast({ title: '保存失败', icon: 'none' });
    }).then(() => this.setData({ saving: false }));
  },

  // 历史对局直达回放（v1.2）
  onOpenReplay(e) {
    const g = this.data.recentGames[e.currentTarget.dataset.index];
    if (g && g.gameId) {
      wx.navigateTo({ url: '/pages/replay/replay?gameId=' + g.gameId });
    }
  },

  // v1.5 重看新手引导：清除标记后回大厅触发
  onReplayGuide() {
    try { wx.removeStorageSync('fc_guide_seen'); } catch (e) { /* 忽略 */ }
    wx.showToast({ title: '回大厅为你重播引导', icon: 'none' });
    setTimeout(() => wx.reLaunch({ url: '/pages/hall/hall' }), 900);
  },

  goHall() {
    wx.reLaunch({ url: '/pages/hall/hall' });
  }
});
