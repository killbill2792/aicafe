const CACHE_NAME = "cafe-profit-v1";
const APP_SHELL = ["/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

// Generic lock-screen text only. Never display the café, report, owner, or
// confidential evidence in a push preview. Work fetches RLS-protected detail.
self.addEventListener("push", (event) => {
  let path = "/operations";
  try {
    const payload = event.data?.json();
    if (payload && typeof payload.url === "string" &&
      /^\/api\/ai\/work\/open\?run=[0-9a-f-]{36}$/iu.test(payload.url))
      path = payload.url;
  } catch { /* malformed/untrusted push has no private detail */ }
  event.waitUntil(self.registration.showNotification("AI Café", {
    body: "A Luna report is ready in Work.",
    tag: "u4-owner-report",
    data: { path },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.path;
  const safe = typeof path === "string" &&
    (/^\/api\/ai\/work\/open\?run=[0-9a-f-]{36}$/iu.test(path)||
      path==="/operations")
    ? path : "/operations";
  event.waitUntil(self.clients.openWindow(safe));
});
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request)),
  );
});
