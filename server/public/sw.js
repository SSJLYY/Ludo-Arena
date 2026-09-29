/* flychess service worker — PWA 可装到主屏 + 离线兜底
 * v33 策略调整：
 *   - 只缓存「导航 + 静态资源」（/ /css /js /manifest /icon），保证每次部署即时生效；
 *   - /api/* 一律 network-only：接口数据是实时的，缓存会把榜单/战绩/房间列表变成陈旧数据，
 *     且带 nick 查询串的请求会无上限堆积，白白吃掉浏览器配额；
 *   - 只缓存成功响应（res.ok），异常页不再被长期留存。
 */
const V = 'flychess-v44';
const SHELL = [
  '/', '/css/style.css', '/js/board.js', '/js/fx.js', '/js/api.js', '/js/app.js',
  '/js/qr.js', '/js/i18n.js', '/manifest.webmanifest', '/icon.svg',
];
// 缓存条目上限（含运行时新增的静态资源），超出后清理最旧的，防止配额膨胀
const MAX_ENTRIES = 60;

const isCacheable = (url) => {
  const p = url.pathname;
  if (url.pathname.startsWith('/api/')) return false;   // 接口永不缓存
  if (url.pathname.startsWith('/admin')) return false;  // 后台页不缓存
  return SHELL.includes(p)
    || p.endsWith('.js') || p.endsWith('.css')
    || p.endsWith('.svg') || p.endsWith('.png') || p.endsWith('.webmanifest');
};

async function trimCache(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length <= MAX_ENTRIES) return;
    const extra = keys.slice(0, keys.length - MAX_ENTRIES);
    await Promise.all(extra.map((k) => cache.delete(k)));
  } catch (e) { /* ignore */ }
}

self.addEventListener('install', (e) => {
  self.skipWaiting();
  // v37 预缓存用 cache:'reload' 绕过 HTTP 缓存：静态资源现带 max-age=600，
  // 否则部署后一小时内 SW 可能预缓存到旧文件，新缓存名就失去意义了
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;

  // 非缓存目标（接口/后台）：纯网络，失败就让它失败，前端有各自的错误处理
  if (!isCacheable(u)) return;

  // 导航请求：network-first，离线回退首页（保证离线可打开，不白屏）
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          if (r && r.ok) {
            const cp = r.clone();
            caches.open(V).then((c) => c.put('/', cp)).catch(() => {});
          }
          return r;
        })
        .catch(() => caches.match('/').then((m) => m || Response.error()))
    );
    return;
  }

  // 静态资源：stale-while-revalidate（先给缓存保证秒开，后台顺带更新）
  e.respondWith(
    caches.open(V).then((cache) => cache.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((r) => {
          if (r && r.ok) {
            cache.put(e.request, r.clone()).then(() => trimCache(cache)).catch(() => {});
          }
          return r;
        })
        .catch(() => cached);
      return cached || network;
    }))
  );
});
