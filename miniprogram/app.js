// 全局云环境配置：部署时把这里替换成你的云开发环境 ID（README「快速开始」有说明）。
// 留空则使用「默认环境」（仅有一个环境时可用）。
const CLOUD_ENV = '';

App({
  globalData: {
    version: 'v1.19.2',
    openId: '',
    profile: {
      nickName: '',
      avatarUrl: ''
    },
    profileReady: false,
    cloudError: ''
  },

  onLaunch() {
    // v1.19.2：启动链路完全防御式——任何云初始化异常都不得中断 App 生命周期
    // （真机曾报 LifeCycle.load fail: Cannot set a non-pending waiting value，
    //  框架级状态错误，onLaunch 抛错是其触发路径之一）
    try {
      if (!wx.cloud) {
        wx.showModal({
          title: '提示',
          content: '当前微信版本过低，无法使用云开发能力，请升级微信后重试。',
          showCancel: false
        });
        return;
      }
      const initOpt = { traceUser: true };
      if (CLOUD_ENV) initOpt.env = CLOUD_ENV;
      wx.cloud.init(initOpt);
    } catch (e) {
      console.error('[app] cloud init failed', e);
    }

    try {
      this.loadLocalProfile();
    } catch (e) {
      console.error('[app] loadLocalProfile failed', e);
    }

    try {
      this.fetchProfile();
    } catch (e) {
      console.error('[app] fetchProfile failed', e);
    }
  },

  // 本地缓存的头像昵称，先展示后校准
  loadLocalProfile() {
    try {
      const cached = wx.getStorageSync('fc_profile');
      if (cached && (cached.nickName || cached.avatarUrl)) {
        this.globalData.profile = {
          nickName: cached.nickName || '',
          avatarUrl: cached.avatarUrl || ''
        };
        this.globalData.profileReady = true;
      }
    } catch (e) { /* 忽略缓存读取失败 */ }
  },

  // login 云函数：拿 openId + 拉取/合并用户资料（头像昵称填写能力，合规）
  fetchProfile() {
    const login = require('./services/login.js');
    return login.ensureLogin().then((res) => {
      this.globalData.openId = res.openId;
      if (res.user && (res.user.nickName || res.user.avatarUrl)) {
        this.globalData.profile = {
          nickName: res.user.nickName || this.globalData.profile.nickName,
          avatarUrl: res.user.avatarUrl || this.globalData.profile.avatarUrl
        };
        try { wx.setStorageSync('fc_profile', this.globalData.profile); } catch (e) { /* 忽略 */ }
      }
      this.globalData.profileReady = true;
      return res;
    }).catch((e) => {
      // v1.19.3 记录云调用失败的真实原因，供大厅页提示
      this.globalData.cloudError = (e && e.message) || '云调用失败';
      console.error('[app] fetchProfile failed:', this.globalData.cloudError);
      // 离线/云环境未配置时不阻塞本地体验
      if (!this.globalData.profile.nickName) {
        this.globalData.profile.nickName = '飞机师' + Math.floor(1000 + Math.random() * 9000);
      }
      this.globalData.profileReady = true;
      return null;
    });
  },

  // 保存头像昵称（mine 页调用）
  saveProfile(patch) {
    const p = this.globalData.profile;
    if (patch.nickName !== undefined) p.nickName = patch.nickName;
    if (patch.avatarUrl !== undefined) p.avatarUrl = patch.avatarUrl;
    try { wx.setStorageSync('fc_profile', p); } catch (e) { /* 忽略 */ }
    const login = require('./services/login.js');
    return login.updateUser(p).catch(() => null);
  }
});
