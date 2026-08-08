const CACHE_PREFIX = 'evo-control-'
const CACHE_NAME = `${CACHE_PREFIX}__BUILD_ID__`
const scopeUrl = new URL('./', self.registration.scope).href
const BUILD_ASSETS = []
const APP_SHELL = [
  scopeUrl,
  new URL('manifest.webmanifest', scopeUrl).href,
  new URL('favicon.svg', scopeUrl).href,
  new URL('icon.svg', scopeUrl).href,
  new URL('icon-maskable.svg', scopeUrl).href,
  ...BUILD_ASSETS.map((asset) => new URL(asset, scopeUrl).href),
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            void caches.open(CACHE_NAME).then((cache) => cache.put(scopeUrl, response.clone()))
          }
          return response
        })
        .catch(async () => (await caches.match(scopeUrl)) || Response.error()),
    )
    return
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok) {
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()))
          }
          return response
        }),
    ),
  )
})
