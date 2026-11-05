// Flux audio : liens de YouTube obtenus à la demande, servis à l'interface par « nova-stream://audio/ID ».
// Le processus principal relaie les requêtes (avec les plages d'octets) : un lien expiré ou refusé
// est remplacé à la volée, sans que la lecture ne s'interrompe.
import { protocol } from 'electron';
import { stream, type Stream } from './yt.js';

const cache = new Map<string, Stream>();
const pending = new Map<string, Promise<Stream>>();
let highQuality = true;
// Extractions non urgentes (titre suivant) : une seule à la fois, pour ménager le processeur.
let backgroundChain: Promise<unknown> = Promise.resolve();

export function setQuality(high: boolean) {
  if (high !== highQuality) cache.clear();
  highQuality = high;
}

export function resolveStream(id: string, force = false): Promise<Stream> {
  const hit = cache.get(id);
  if (!force && hit && hit.expires > Date.now() + 60_000) return Promise.resolve(hit);
  const running = pending.get(id);
  if (running) return running;
  const task = stream(id, highQuality)
    .then((found) => {
      cache.set(id, found);
      if (cache.size > 300) cache.delete(cache.keys().next().value as string);
      return found;
    })
    .finally(() => pending.delete(id));
  pending.set(id, task);
  return task;
}

/** Prépare le titre suivant en arrière-plan (jamais deux à la fois). */
export function prefetch(id: string) {
  if (cache.has(id) || pending.has(id)) return;
  backgroundChain = backgroundChain.then(() => resolveStream(id).catch(() => undefined));
}

export function invalidate(id: string) {
  cache.delete(id);
}

export function invalidateAll() {
  cache.clear();
}

export function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'nova-stream',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true },
  }]);
}

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export function handleStreams() {
  protocol.handle('nova-stream', async (request) => {
    const id = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''));
    const range = request.headers.get('range') ?? 'bytes=0-';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const found = await resolveStream(id, attempt > 0);
        const upstream = await fetch(found.url, { headers: { range, 'user-agent': userAgent } });
        // Lien expiré, refusé ou lié à un autre réseau : on en demande un neuf.
        if ([403, 404, 410].includes(upstream.status)) {
          invalidate(id);
          continue;
        }
        const headers = new Headers();
        headers.set('content-type', found.mime);
        headers.set('accept-ranges', 'bytes');
        for (const name of ['content-length', 'content-range']) {
          const value = upstream.headers.get(name);
          if (value) headers.set(name, value);
        }
        return new Response(upstream.body, { status: upstream.status, headers });
      } catch (error) {
        if (attempt === 2) return new Response(String(error), { status: 502 });
        invalidate(id);
      }
    }
    return new Response('Flux indisponible', { status: 502 });
  });
}
