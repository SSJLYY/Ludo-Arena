// 实时同步：数据库 watch 封装（断线自动重连 + 轮询兜底）+ 心跳
// 架构文档第四节：单向数据流，客户端只收快照、只发 action
const api = require('./api.js');

function watchDoc(collection, docId, onData, onError) {
  let watcher = null;
  let closed = false;
  let retry = 0;
  let lastAt = Date.now();
  let guardTimer = null;
  let reconnectTimer = null;

  function startWatch() {
    if (closed) return;
    try {
      watcher = wx.cloud.database().collection(collection).doc(docId).watch({
        onChange(snapshot) {
          lastAt = Date.now();
          retry = 0;
          const doc = snapshot && snapshot.docs && snapshot.docs[0];
          if (doc) onData(doc);
        },
        onError(err) {
          console.error('[sync] watch error', collection, err);
          if (onError) onError(err);
          scheduleReconnect();
        }
      });
    } catch (e) {
      console.error('[sync] watch init failed', e);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (closed) return;
    destroyWatcher();
    const delay = Math.min(1000 * Math.pow(2, retry++), 10000);
    reconnectTimer = setTimeout(() => { if (!closed) startWatch(); }, delay);
  }

  // watch 静默失败兜底：超过 10s 无推送则主动拉一次（5s 检查一次）
  function startGuard() {
    guardTimer = setInterval(async () => {
      if (closed) return;
      if (Date.now() - lastAt > 10000) {
        lastAt = Date.now();
        try {
          const doc = collection === 'games'
            ? await api.fetchGame(docId)
            : await api.fetchRoom(docId);
          if (doc && !closed) onData(doc);
        } catch (e) { /* 文档可能已删除 */ }
      }
    }, 5000);
  }

  function destroyWatcher() {
    if (watcher) {
      try { watcher.close(); } catch (e) { /* 忽略 */ }
      watcher = null;
    }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  startWatch();
  startGuard();

  return {
    close() {
      closed = true;
      destroyWatcher();
      if (guardTimer) { clearInterval(guardTimer); guardTimer = null; }
    }
  };
}

// 对局会话：games + rooms 双 watch + 10s 心跳
// hostedProvider：返回当前用户是否主动托管中（v1.1），心跳期间保持托管态
function createSession(opts) {
  const { gameId, roomId, onGame, onRoom, hostedProvider } = opts;
  let gameWatcher = null;
  let roomWatcher = null;
  let heartbeatTimer = null;
  let stopped = false;

  function beat() {
    if (stopped || !roomId) return;
    const hosted = hostedProvider ? !!hostedProvider() : undefined;
    api.heartbeat(roomId, hosted).catch(() => { });
  }

  return {
    start() {
      if (gameId && onGame) {
        gameWatcher = watchDoc('games', gameId, onGame);
      }
      if (roomId && onRoom) {
        roomWatcher = watchDoc('rooms', roomId, onRoom);
      }
      beat();
      heartbeatTimer = setInterval(beat, 10000);
    },
    stop() {
      stopped = true;
      if (gameWatcher) { gameWatcher.close(); gameWatcher = null; }
      if (roomWatcher) { roomWatcher.close(); roomWatcher = null; }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    }
  };
}

module.exports = { watchDoc, createSession };
