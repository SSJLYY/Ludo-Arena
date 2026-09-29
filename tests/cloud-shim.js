'use strict';

// ============================================================
// wx-server-sdk 内存模拟器（测试专用）
// 进程内拦截 require('wx-server-sdk')，为云函数提供可断言的
// 数据库 / OPENID / openapi 假实现。不进入小程序与云函数部署包。
// ============================================================

const Module = require('module');

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function getPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = parts[i + 1];
    if (cur[key] === undefined || cur[key] === null) {
      cur[key] = /^\d+$/.test(next) ? [] : {};
    }
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

function applyUpdate(doc, data) {
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (v && typeof v === 'object' && v.__cmd === 'inc') {
      const cur = getPath(doc, k) || 0;
      setPath(doc, k, cur + v.val);
    } else {
      setPath(doc, k, clone(v));
    }
  }
}

function createDb() {
  const collections = new Map();
  let autoId = 0;

  function coll(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  function matchingIds(name, cond) {
    const out = [];
    for (const [id, doc] of coll(name).entries()) {
      let ok = true;
      for (const key of Object.keys(cond || {})) {
        const expected = cond[key];
        // 真实 CloudBase 的 get/where 结果都带 _id 字段；存储层以键存放，匹配时特殊处理
        const actual = key === '_id' ? id : getPath(doc, key);
        if (expected && typeof expected === 'object' && expected.__cmd) {
          if (expected.__cmd === 'gt' && !(actual > expected.val)) { ok = false; break; }
          if (expected.__cmd === 'lt' && !(actual < expected.val)) { ok = false; break; }
        } else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          ok = false; break;
        }
      }
      if (ok) out.push(id);
    }
    return out;
  }

  function makeQuery(name, cond) {
    const q = { order: null, skipN: 0, limitN: 0 };
    const applyShape = (docs) => {
      if (q.order) {
        docs.sort((a, b) => {
          const av = getPath(a, q.order.field);
          const bv = getPath(b, q.order.field);
          const d = (av > bv ? 1 : av < bv ? -1 : 0);
          return q.order.dir === 'desc' ? -d : d;
        });
      }
      if (q.skipN) docs = docs.slice(q.skipN);
      if (q.limitN) docs = docs.slice(0, q.limitN);
      return docs;
    };
    const h = {
      get: async () => {
        let docs = matchingIds(name, cond).map((id) => {
          const d = clone(coll(name).get(id));
          d._id = id;
          return d;
        });
        docs = applyShape(docs);
        return { data: docs };
      },
      count: async () => ({ total: matchingIds(name, cond).length }),
      update: async ({ data }) => {
        let n = 0;
        for (const id of matchingIds(name, cond)) {
          const doc = coll(name).get(id);
          applyUpdate(doc, data);
          n++;
        }
        return { stats: { updated: n } };
      },
      remove: async () => {
        const ids = matchingIds(name, cond);
        for (const id of ids) coll(name).delete(id);
        return { stats: { removed: ids.length } };
      },
      orderBy: (field, dir) => { q.order = { field: field, dir: dir }; return h; },
      skip: (n) => { q.skipN = n; return h; },
      limit: (n) => { q.limitN = n; return h; }
    };
    return h;
  }

  const db = {
    collection: (name) => ({
      doc: (id) => ({
        get: async () => {
          const d = coll(name).get(id);
          if (!d) {
            const e = new Error('document.get: document not exists');
            e.errCode = -502004;
            throw e;
          }
          const out = clone(d);
          out._id = id;
          return { data: out };
        },
        set: async ({ data }) => {
          coll(name).set(id, clone(data));
          return { _id: id, updated: 1 };
        },
        update: async ({ data }) => {
          const d = coll(name).get(id);
          if (!d) {
            const e = new Error('document.update: document not exists');
            e.errCode = -502004;
            throw e;
          }
          applyUpdate(d, data);
          return { stats: { updated: 1 } };
        },
        remove: async () => {
          coll(name).delete(id);
          return { stats: { removed: 1 } };
        }
      }),
      add: async ({ data }) => {
        const id = 'auto' + (++autoId) + Math.random().toString(36).slice(2, 6);
        coll(name).set(id, clone(data));
        return { _id: id };
      },
      where: (cond) => makeQuery(name, cond)
    }),
    command: {
      gt: (v) => ({ __cmd: 'gt', val: v }),
      lt: (v) => ({ __cmd: 'lt', val: v }),
      inc: (v) => ({ __cmd: 'inc', val: v })
    },
    __reset: () => collections.clear(),
    __dump: (name) => {
      const out = {};
      for (const [id, doc] of coll(name).entries()) out[id] = clone(doc);
      return out;
    }
  };
  return db;
}

function createCloud(db) {
  const cloud = {
    DYNAMIC_CURRENT_ENV: Symbol('DYNAMIC_CURRENT_ENV'),
    currentOpenId: '',
    // msgSecCheck 行为控制：'pass'（默认）| 'risky'（87014 违规）| 'error'（服务不可用）
    secCheckMode: 'pass',
    init() { },
    getWXContext: () => ({ OPENID: cloud.currentOpenId || '' }),
    database: () => db,
    uploadFile: async ({ cloudPath }) => ({ fileID: 'cloud://mock/' + cloudPath }),
    getTempFileURL: async ({ fileList }) => ({
      fileList: fileList.map((f) => ({ fileID: f, tempFileURL: 'https://mock/' + f }))
    }),
    openapi: {
      security: {
        msgSecCheck: async ({ content }) => {
          if (cloud.secCheckMode === 'risky') {
            throw Object.assign(new Error('content invalid'), { errCode: 87014 });
          }
          if (cloud.secCheckMode === 'error') {
            throw Object.assign(new Error('openapi unavailable'), { errCode: -604000 });
          }
          const bad = ['垃圾', '诈骗'];
          for (const w of bad) {
            if (String(content || '').indexOf(w) >= 0) {
              throw Object.assign(new Error('content invalid'), { errCode: 87014 });
            }
          }
          return { result: { suggest: 'pass' } };
        }
      },
      wxacode: {
        getUnlimited: async () => ({ buffer: Buffer.from('fake-png-' + Date.now()) })
      }
    }
  };
  return cloud;
}

// 拦截 require('wx-server-sdk')：返回注入的 mock 实例
function install(cloud) {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloud;
    return origLoad.apply(this, arguments);
  };
  return function uninstall() {
    Module._load = origLoad;
  };
}

module.exports = { createDb, createCloud, install, clone };
