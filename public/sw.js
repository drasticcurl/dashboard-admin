/*
  Service worker del panel. SOLO avisos push: no cachea nada.

  Es un panel de métricas en vivo con `Cache-Control: no-store` (middleware.ts):
  servir una pantalla vieja desde un caché offline mostraría números falsos con
  cara de reales. Por eso no hay handler de `fetch`; el navegador va a la red
  como si el worker no existiera.
*/

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Panel', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Panel';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      // Las ventas mandan el suyo (verde front, ámbar upsell); el profit usa el de la app.
      icon: data.icon || '/pwa/icon-192.png',
      badge: '/pwa/badge.png',
      // Mismo tag = el aviso nuevo reemplaza al anterior en la bandeja, en vez
      // de apilar seis profits viejos.
      tag: data.tag || 'profit',
      renotify: true,
      data: { url: data.url || '/resumen' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/resumen';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
      for (const v of ventanas) {
        if ('focus' in v) {
          v.navigate(url);
          return v.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
