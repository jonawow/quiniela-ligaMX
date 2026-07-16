/* ═══════════════════════════════════════════════════════════════════════
   QUINIELA MX · Service Worker
   ═══════════════════════════════════════════════════════════════════════

   ⚠️  AL SUBIR CAMBIOS, SUBE ESTE NÚMERO ⬇
   Es lo único que hay que tocar. Si no lo subes, el navegador cree que el
   service worker es el mismo de antes y a la gente NO le sale el aviso de
   nueva versión.

   ── POR QUÉ ESTÁ HECHO ASÍ ────────────────────────────────────────────
   Un service worker mal armado es PEOR que no tener ninguno: en vez de
   pedirle a la gente que borre el caché una vez, la app se les queda
   pegada para siempre y ni borrando el caché se arregla.

   Por eso aquí la regla es "primero la red, el caché es el respaldo":
     · Si hay internet → siempre bajan lo último. Nunca ven algo viejo.
     · Si no hay        → sale lo último que se guardó, y la app abre igual.

   Lo contrario ("primero el caché") sería más rápido, pero significa
   enseñar la versión vieja a propósito. En una quiniela donde los
   marcadores se mueven, eso no se vale.
   ═══════════════════════════════════════════════════════════════════════ */

const VERSION = 'qmx-v1';        // ⬅ SÚBELE AQUÍ (v2, v3...) EN CADA CAMBIO

const CACHE_APP = `${VERSION}-app`;
const CACHE_FIJO = `${VERSION}-fijo`;

// El esqueleto: lo mínimo para que la app abra aunque no haya señal.
const ESQUELETO = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

// ── Instalar ───────────────────────────────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_APP)
      .then((c) => c.addAll(ESQUELETO))
      // OJO: NO llamamos skipWaiting() aquí. Si lo hiciéramos, el service
      // worker nuevo tomaría el control de golpe mientras alguien está a
      // medio pronosticar. Se queda esperando hasta que la persona toque
      // "Actualizar" en el aviso — ahí sí (ver el listener de mensajes).
      .catch(() => { /* si un archivo falla, no tumbamos la instalación */ })
  );
});

// ── Activar: barrer los cachés de versiones viejas ─────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const nombres = await caches.keys();
    await Promise.all(
      nombres.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

// ── El aviso de "actualiza" ────────────────────────────────────────────
self.addEventListener('message', (e) => {
  // La página nos lo manda cuando la persona toca "Actualizar".
  if (e.data === 'ACTUALIZAR_YA') self.skipWaiting();
});

// ── Interceptar peticiones ─────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Solo GET. Un POST (mandar un pronóstico) jamás se toca ni se guarda.
  if (req.method !== 'GET') return;

  // SUPABASE: NUNCA se cachea. Son los datos vivos — marcadores, quién va
  // ganando, el bote. Servir esto de caché sería mentirle a la gente con
  // un marcador viejo. Si no hay red, que falle: la página ya sabe
  // aguantarse (ver el sondeo en app.js).
  if (url.hostname.endsWith('.supabase.co')) return;

  // Escudos y tipografías: no cambian nunca. Primero el caché, y así los
  // escudos no se vuelven a bajar en cada jornada.
  if (url.hostname.includes('espncdn.com') ||
      url.hostname.includes('fonts.g') ||
      url.hostname.includes('jsdelivr.net')) {
    e.respondWith(primeroElCache(req));
    return;
  }

  // Todo lo nuestro (html/css/js/iconos): primero la red.
  if (url.origin === self.location.origin) {
    e.respondWith(primeroLaRed(req));
  }
});

// Primero la red; si no hay, lo guardado. Es lo que evita que la gente se
// quede viendo una versión vieja sin saberlo.
async function primeroLaRed(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const copia = res.clone();
      caches.open(CACHE_APP).then((c) => c.put(req, copia)).catch(() => {});
    }
    return res;
  } catch {
    const guardado = await caches.match(req);
    if (guardado) return guardado;

    // Sin red y sin copia: si iba navegando, al menos le damos el index.
    if (req.mode === 'navigate') {
      const inicio = await caches.match('./index.html');
      if (inicio) return inicio;
    }
    throw new Error('sin red y sin copia guardada');
  }
}

// Primero lo guardado, y si no está lo bajamos. Solo para cosas que no
// cambian: escudos, tipografías, librerías con versión fija.
async function primeroElCache(req) {
  const guardado = await caches.match(req);
  if (guardado) return guardado;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) {
      const copia = res.clone();
      caches.open(CACHE_FIJO).then((c) => c.put(req, copia)).catch(() => {});
    }
    return res;
  } catch {
    return new Response('', { status: 504 });
  }
}
