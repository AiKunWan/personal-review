// 个人点评 PWA service worker — 缓存应用外壳，支持离线/外地打开
// 缓存名带一个版本后缀。**改了它就会触发一次全新的 install + activate**，
// 旧缓存被 activate 里的那段逻辑清掉。它不是「必须每次发版改」的东西
// （fetch 用的是 stale-while-revalidate，不会把用户钉死在旧版），
// 但想强制立刻清一遍旧缓存时，改这里最直接。
const CACHE = 'waimai-shell-v3';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// stale-while-revalidate：**先用缓存立刻响应，同时后台回源把缓存刷新**。
//
// 原来这里是纯 cache-first 且从不回源 —— 那样一旦注册成功，就算换了新版、
// app.js 变了，sw.js 自身内容没变就不会重新 install，用户会被**永久钉在**
// 首次缓存的那一版上，而且没有任何提示。改成每次回源更新后，
// 最坏情况也只是「落后一次打开」，离线时照旧直接用缓存。
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // 只接管同源请求：跨域的（以后万一加）交给浏览器默认行为
  let sameOrigin = false;
  try { sameOrigin = new URL(req.url).origin === self.location.origin; } catch (e) { sameOrigin = false; }
  if (!sameOrigin) return;
  event.respondWith(
    caches.match(req).then((hit) => {
      // 注意：这个 Promise 在创建时就发起了请求，所以命中缓存时它照样在后台跑
      const fresh = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => { /* 配额满也不该影响响应 */ });
        }
        return res;
      }).catch(() => null);
      // 命中缓存 → 立刻返回（fresh 在后台更新缓存）
      // 没命中 → 等网络；网络也失败 → 回落 index.html（离线单页应用的做法）
      return hit || fresh.then((r) => r || caches.match('./index.html'));
    })
  );
});
