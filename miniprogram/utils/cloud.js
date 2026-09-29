// 云函数调用统一封装：loading、错误码转文案、统一抛错
function call(name, data, opts) {
  const options = opts || {};
  if (options.loading) {
    wx.showLoading({ title: options.loadingText || '请稍候…', mask: true });
  }
  return wx.cloud.callFunction({ name, data: data || {} }).then((res) => {
    if (options.loading) wx.hideLoading();
    const result = res && res.result;
    if (!result) {
      throw makeErr('EMPTY_RESPONSE', '云函数返回为空（' + name + ' 可能未正确部署）');
    }
    if (result.err) {
      throw makeErr(result.err, result.msg || errText(result.err));
    }
    return result;
  }).catch((e) => {
    if (options.loading) wx.hideLoading();
    // 真实原因永远进日志（真机 vConsole 可见）
    console.error('[cloudCall:' + name + ']', e && (e.errMsg || e.message), e);
    if (e && e.code) throw e;
    throw makeErr('NETWORK', diagnoseCloudError(name, e));
  });
}

// v1.19.3：把 wx.cloud 底层错误翻译成可行动的原因（而不是笼统的「网络异常」）
function diagnoseCloudError(name, e) {
  const msg = String((e && (e.errMsg || e.message)) || JSON.stringify(e || {}));
  if (msg.indexOf('Cloud API') >= 0 || msg.indexOf('invalid scope') >= 0 || msg.indexOf('-501000') >= 0) {
    return '云开发未开通或环境未关联：请在开发者工具开通云开发，并确认 appid 与环境匹配';
  }
  if (/env.*(invalid|not exist|not found)/i.test(msg) || msg.indexOf('-601100') >= 0) {
    return '云开发环境无效：请在 miniprogram/app.js 填入 CLOUD_ENV 环境ID';
  }
  if (msg.indexOf('not found') >= 0 || msg.indexOf('-404') >= 0 || msg.indexOf('FUNCTIONS_NOT_FOUND') >= 0) {
    return '云函数 ' + name + ' 未部署：请在开发者工具 cloudfunctions 下右键「上传并部署」';
  }
  if (msg.indexOf('env check invalid') >= 0 || msg.indexOf('invalid appid') >= 0) {
    return 'appid 与云环境不匹配：确认 project.config.json 的 appid 属于开通云开发的账号';
  }
  return '网络异常：' + msg.slice(0, 80);
}

function makeErr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function errText(code) {
  const map = {
    ROOM_FULL: '房间已满，去开个新房间吧',
    ROOM_NOT_FOUND: '房间不存在或已解散',
    ROOM_STARTED: '对局已经开始啦',
    ROOM_CLOSED: '房间已关闭',
    WRONG_PASSWORD: '房间密码错误',
    LOCKED: '密码错误次数过多，请稍后再试',
    NOT_OWNER: '只有房主可以进行该操作',
    NOT_IN_ROOM: '你还不在这个房间里',
    SEAT_TAKEN: '手慢了，座位刚被别人坐了',
    NOT_ENOUGH_PLAYERS: '还需要凑满 4 位玩家才能开局',
    NOT_YOUR_TURN: '还没轮到你',
    ILLEGAL_ACTION: '无效操作',
    PLANE_NOT_MOVABLE: '这架飞机当前不能移动',
    GAME_ENDED: '对局已结束',
    SEQ_CONFLICT: '操作冲突，请重试',
    NETWORK: '网络异常，请检查网络后重试'
  };
  return map[code] || '操作失败，请重试';
}

function toastErr(e, fallback) {
  const msg = (e && e.message) || fallback || '操作失败';
  wx.showToast({ title: msg, icon: 'none', duration: 2200 });
}

module.exports = { call, toastErr, errText, makeErr };
