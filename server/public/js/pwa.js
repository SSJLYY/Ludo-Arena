/* pwa.js — Service Worker 注册（v45 从 index.html 内联迁出，配合 CSP script-src 'self'） */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () { /* 忽略：PWA 非核心 */ });
  });
}
