import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const token = () => randomBytes(24).toString('hex');
const now = () => Date.now();
const memberName = value => typeof value === 'string' ? value.trim().slice(0, 40) || 'Ami Nova' : 'Ami Nova';
const responseHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Cache-Control': 'no-store',
};
const appPath = '/nova-jam/app/';
const assets = new Map([
  ['', ['index.html', 'text/html; charset=utf-8']],
  ['app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['style.css', ['style.css', 'text/css; charset=utf-8']],
  ['manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['icon-192.png', ['icon-192.png', 'image/png']],
  ['icon-512.png', ['icon-512.png', 'image/png']],
]);

async function searchOctave(query) {
  const url = new URL('https://api.octavestreaming.com/api/search/page');
  url.search = new URLSearchParams({ query, limit: '12' }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(4500), redirect: 'error' });
  if (!response.ok) throw new Error('Octave indisponible');
  const data = await response.json();
  return (Array.isArray(data.tracks) ? data.tracks : []).slice(0, 12).flatMap(entry => {
    const id = String(entry?.id ?? '');
    const albumId = String(entry?.album?.id ?? '');
    if (!/^\d{1,20}$/.test(id) || !/^\d{1,20}$/.test(albumId)
      || typeof entry.title !== 'string' || typeof entry.artist?.name !== 'string') return [];
    const artwork = entry.album.cover_medium ?? entry.album.cover_big;
    return [{ id: 'octave:' + id, title: entry.title.slice(0, 300), artist: entry.artist.name.slice(0, 300),
      album: typeof entry.album.title === 'string' ? entry.album.title.slice(0, 300) : undefined,
      albumId: 'octave:' + albumId, duration: Number.isFinite(entry.duration) ? entry.duration : undefined,
      artwork: typeof artwork === 'string' && artwork.startsWith('https://') ? artwork : undefined, square: true }];
  });
}

export function createJamRelay(key, catalog = searchOctave) {
  if (typeof key !== 'string' || !/^[a-f0-9]{32,128}$/i.test(key)) {
    throw new Error('NOVA_JAM_KEY doit contenir au moins 32 caractères hexadécimaux aléatoires.');
  }
  const secret = Buffer.from('Bearer ' + key);
  const rooms = new Map();
  const expiry = 35_000;
  const authorized = (value, expected = secret) => {
    const header = Buffer.from(value ?? '');
    return header.length === expected.length && timingSafeEqual(expected, header);
  };

  const server = createServer({ requestTimeout: 15_000 }, async (request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, responseHeaders);
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };
    const path = (request.url ?? '').split('?')[0];
    if (path.startsWith(appPath) && ['GET', 'HEAD'].includes(request.method)) {
      const asset = assets.get(path.slice(appPath.length));
      if (!asset) return reply(404, { error: 'Page inconnue.' });
      const [file, type] = asset;
      try {
        const content = await readFile(new URL('./web/' + file, import.meta.url));
        response.writeHead(200, {
          'Content-Type': type, 'Content-Length': content.length, 'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; img-src 'self' https:; frame-ancestors 'none'; base-uri 'none'",
          'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
        });
        return response.end(request.method === 'HEAD' ? undefined : content);
      } catch {
        return reply(404, { error: 'Page indisponible.' });
      }
    }
    if (!/^\/nova-jam\/?$/.test(path)) return reply(404, { error: 'Route inconnue.' });
    if (request.method === 'OPTIONS') return reply(204);
    if (request.method !== 'POST') return reply(405, { error: 'Méthode indisponible.' });
    const circle = authorized(request.headers.authorization);
    if (!circle && !/^Bearer [a-f0-9]{48}$/.test(request.headers.authorization ?? '')) {
      return reply(401, { error: 'Lien d’invitation requis.' });
    }

    let message;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 512 * 1024) { request.destroy(); return; }
        chunks.push(chunk);
      }
      message = JSON.parse(Buffer.concat(chunks));
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
    } catch {
      return reply(400, { error: 'Requête illisible.' });
    }

    const time = now();
    for (const [id, room] of rooms) {
      if (time - room.hostSeen > expiry) rooms.delete(id);
      else for (const [id, guest] of room.guests) if (time - guest.seen > expiry) room.guests.delete(id);
    }
    if (circle && message.action === 'list') return reply(200, { rooms: [...rooms.values()].map(room => ({
      id: room.id, name: room.name, people: room.guests.size + 1,
    })) });
    if (circle && message.action === 'host') {
      if (rooms.size >= 32) return reply(429, { error: 'Le cercle est plein.' });
      const room = { id: randomBytes(8).toString('hex'), name: memberName(message.name), host: token(), invite: token(),
        hostSeen: time, guests: new Map(), messages: [], sequence: 0, version: 0 };
      rooms.set(room.id, room);
      return reply(200, { id: room.id, token: room.host, invite: room.invite });
    }

    const room = rooms.get(message.room);
    if (!circle && !['join', 'poll', 'search', 'send', 'leave'].includes(message.action)) {
      return reply(401, { error: 'Ce lien est réservé à un seul Jam.' });
    }
    if (!room) return reply(404, { error: 'Ce Jam est terminé.' });
    if (!circle && !authorized(request.headers.authorization, Buffer.from('Bearer ' + room.invite))) {
      return reply(403, { error: 'Invitation invalide pour ce Jam.' });
    }
    if (message.action === 'join') {
      if (room.guests.size >= 16) return reply(429, { error: 'Ce Jam est complet.' });
      const guest = token();
      room.guests.set(guest, { name: memberName(message.name), seen: time });
      return reply(200, { id: room.id, token: guest });
    }
    const host = circle && room.host === message.token;
    const guest = room.guests.get(message.token);
    if (!host && !guest) return reply(403, { error: 'Session expirée.' });
    if (host) room.hostSeen = time;
    if (guest) guest.seen = time;
    if (message.action === 'leave') {
      if (host) rooms.delete(room.id);
      else room.guests.delete(message.token);
      return reply(200, {});
    }
    if (message.action === 'poll') {
      if (host) return reply(200, { participants: [...room.guests.values()].map(guest => guest.name),
        events: room.messages.filter(event => event.seq > (Number.isSafeInteger(message.after) ? message.after : 0)) });
      return reply(200, { version: room.version, state: room.version > message.after ? room.state : undefined });
    }
    if (message.action === 'search' && guest) {
      const query = typeof message.query === 'string' ? message.query.trim() : '';
      if (query.length < 2 || query.length > 100) return reply(400, { error: 'Saisis entre 2 et 100 caractères.' });
      if (guest.searching || time - (guest.lastSearch ?? 0) < 650) return reply(429, { error: 'Réessaie dans un instant.' });
      guest.searching = true;
      guest.lastSearch = time;
      try { return reply(200, { tracks: await catalog(query) }); }
      catch { return reply(502, { error: 'La recherche Octave est momentanément indisponible.' }); }
      finally { guest.searching = false; }
    }
    if (message.action === 'send' && host) {
      const state = message.state;
      if (!state || !Array.isArray(state.queue) || state.queue.length > 200 ||
        !Number.isInteger(state.index) || state.index < 0 || !Number.isFinite(state.position) ||
        typeof state.playing !== 'boolean' || !Number.isFinite(state.sentAt)) return reply(400, { error: 'État de lecture invalide.' });
      room.state = { ...state, hostName: room.name, participants: [...room.guests.values()].map(guest => guest.name) };
      room.version++;
      return reply(200, {});
    }
    if (message.action === 'send' && guest) {
      let event = message.event;
      if (!event || (event.type !== 'add' && event.type !== 'command') ||
        (event.type === 'command' && !['play', 'pause', 'next', 'previous'].includes(event.command)) ||
        (event.type === 'add' && (!event.track || typeof event.track.id !== 'string' || typeof event.track.title !== 'string' ||
          typeof event.track.artist !== 'string' || JSON.stringify(event.track).length > 8192))) {
        return reply(400, { error: 'Action Jam invalide.' });
      }
      if (event.type === 'command' && room.state?.guestsCanControl === false) {
        return reply(403, { error: 'L’hôte a désactivé les commandes de lecture.' });
      }
      if (event.type === 'add') {
        const { id, title, artist, album, albumId, artwork, duration, youtubeId, square } = event.track;
        if (!/^(?:octave:\d{1,20}|[a-zA-Z0-9_-]{11})$/.test(id) || !title.trim()) {
          return reply(400, { error: 'Identifiant de morceau invalide.' });
        }
        event = { type: 'add', next: event.next === true, track: {
          id, title: title.slice(0, 300), artist: artist.slice(0, 300),
          album: typeof album === 'string' ? album.slice(0, 300) : undefined,
          albumId: typeof albumId === 'string' && /^octave:\d{1,20}$/.test(albumId) ? albumId : undefined,
          artwork: typeof artwork === 'string' && artwork.startsWith('https://') ? artwork : undefined,
          duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
          youtubeId: typeof youtubeId === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(youtubeId) ? youtubeId : undefined,
          square: typeof square === 'boolean' ? square : undefined,
        } };
      }
      room.messages.push({ seq: ++room.sequence, name: guest.name, event });
      if (room.messages.length > 100) room.messages.shift();
      return reply(200, {});
    }
    return reply(400, { error: 'Action Jam inconnue.' });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const port = Number(process.env.NOVA_JAM_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Configure NOVA_JAM_PORT.');
  createJamRelay(process.env.NOVA_JAM_KEY).listen(port, '127.0.0.1', () => {
    console.log('Relais Jam Nova sur 127.0.0.1:' + port);
  });
}
