import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
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

export function createJamRelay(key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{32,128}$/i.test(key)) {
    throw new Error('NOVA_JAM_KEY doit contenir au moins 32 caractères hexadécimaux aléatoires.');
  }
  const secret = Buffer.from('Bearer ' + key);
  const rooms = new Map();
  const expiry = 35_000;
  const authorized = value => {
    const header = Buffer.from(value ?? '');
    return header.length === secret.length && timingSafeEqual(secret, header);
  };

  const server = createServer({ requestTimeout: 15_000 }, async (request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, responseHeaders);
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };
    if (!/^\/nova-jam\/?$/.test(request.url ?? '')) return reply(404, { error: 'Route inconnue.' });
    if (request.method === 'OPTIONS') return reply(204);
    if (request.method !== 'POST') return reply(405, { error: 'Méthode indisponible.' });
    if (!authorized(request.headers.authorization)) return reply(401, { error: 'Lien du cercle invalide.' });

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
    if (message.action === 'list') return reply(200, { rooms: [...rooms.values()].map(room => ({
      id: room.id, name: room.name, people: room.guests.size + 1,
    })) });
    if (message.action === 'host') {
      if (rooms.size >= 32) return reply(429, { error: 'Le cercle est plein.' });
      const room = { id: randomBytes(8).toString('hex'), name: memberName(message.name), host: token(),
        hostSeen: time, guests: new Map(), messages: [], sequence: 0, version: 0 };
      rooms.set(room.id, room);
      return reply(200, { id: room.id, token: room.host });
    }

    const room = rooms.get(message.room);
    if (!room) return reply(404, { error: 'Ce Jam est terminé.' });
    if (message.action === 'join') {
      if (room.guests.size >= 16) return reply(429, { error: 'Ce Jam est complet.' });
      const guest = token();
      room.guests.set(guest, { name: memberName(message.name), seen: time });
      return reply(200, { id: room.id, token: guest });
    }
    const host = room.host === message.token;
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
      const event = message.event;
      if (!event || (event.type !== 'add' && event.type !== 'command') ||
        (event.type === 'command' && !['play', 'pause', 'next', 'previous'].includes(event.command)) ||
        (event.type === 'add' && (!event.track || typeof event.track.id !== 'string' || typeof event.track.title !== 'string' ||
          typeof event.track.artist !== 'string' || JSON.stringify(event.track).length > 8192))) {
        return reply(400, { error: 'Action Jam invalide.' });
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
