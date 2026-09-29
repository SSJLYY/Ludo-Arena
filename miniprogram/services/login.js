// 登录与用户资料：免鉴权（云函数侧 getWXContext().OPENID）
const cloud = require('../utils/cloud.js');

let loginPromise = null;

function ensureLogin() {
  if (!loginPromise) {
    loginPromise = cloud.call('login', {}, { loading: false }).then((res) => {
      // 失败后允许下次重试
      if (!res || !res.openId) loginPromise = null;
      return res;
    }).catch((e) => {
      loginPromise = null;
      throw e;
    });
  }
  return loginPromise;
}

function updateUser(profile) {
  return cloud.call('login', {
    nickName: profile.nickName || '',
    avatarUrl: profile.avatarUrl || ''
  });
}

module.exports = { ensureLogin, updateUser };
