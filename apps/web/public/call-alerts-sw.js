/* global self */
/* Only for call notifications (Android browsers require a service worker to show one). It caches nothing and handles no requests. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((pages) => (pages.length ? pages[0].focus() : self.clients.openWindow('/softphone'))));
});
