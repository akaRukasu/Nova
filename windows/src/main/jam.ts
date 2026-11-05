// Jam sur le réseau local : un PC lance le Jam (serveur TCP annoncé en UDP), les autres le trouvent
// et le rejoignent. Les messages sont des lignes JSON ; l'interface décide quoi en faire.
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import type { NearbyJam } from '../shared/types.js';

const DISCOVERY_PORT = 47821;

type Send = (channel: string, ...args: unknown[]) => void;

let send: Send = () => {};
let server: net.Server | null = null;
let announcer: NodeJS.Timeout | null = null;
let udp: dgram.Socket | null = null;
let listener: dgram.Socket | null = null;
let guests = new Map<net.Socket, string>();
let hostSocket: net.Socket | null = null;
const nearby = new Map<string, NearbyJam & { seen: number }>();

export function setSender(sender: Send) {
  send = sender;
}

function lines(socket: net.Socket, onMessage: (message: any) => void) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try { onMessage(JSON.parse(line)); } catch { /* ligne illisible : ignorée */ }
    }
  });
}

function write(socket: net.Socket, message: unknown) {
  if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n');
}

export function localAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

// MARK: Hôte

export function host(name: string): Promise<{ port: number; addresses: string[] }> {
  stop();
  return new Promise((resolve, reject) => {
    server = net.createServer((socket) => {
      guests.set(socket, 'Invité');
      lines(socket, (message) => {
        if (message.type === 'hello') guests.set(socket, String(message.name ?? 'Invité').slice(0, 40));
        send('jam:fromGuest', message, guests.get(socket));
        if (message.type === 'hello') send('jam:participants', [...guests.values()]);
      });
      const drop = () => {
        const left = guests.get(socket);
        guests.delete(socket);
        send('jam:participants', [...guests.values()]);
        if (left) send('jam:info', `${left} a quitté le Jam`);
      };
      socket.on('close', drop);
      socket.on('error', drop);
    });
    server.on('error', reject);
    server.listen(0, () => {
      const port = (server!.address() as net.AddressInfo).port;
      udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      udp.bind(() => {
        udp!.setBroadcast(true);
        const announce = () => {
          const message = Buffer.from(JSON.stringify({ app: 'nova-jam', name, port }));
          udp?.send(message, DISCOVERY_PORT, '255.255.255.255');
        };
        announce();
        announcer = setInterval(announce, 2000);
      });
      resolve({ port, addresses: localAddresses() });
    });
  });
}

export function broadcast(message: unknown) {
  for (const socket of guests.keys()) write(socket, message);
}

// MARK: Invité

export function browse() {
  if (listener) return;
  listener = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  listener.on('message', (data, info) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.app !== 'nova-jam' || localAddresses().includes(info.address) && server) return;
      const id = `${info.address}:${message.port}`;
      nearby.set(id, { id, name: String(message.name ?? 'Jam'), address: info.address, port: Number(message.port), seen: Date.now() });
      for (const [key, value] of nearby) if (Date.now() - value.seen > 8000) nearby.delete(key);
      send('jam:nearby', [...nearby.values()].map(({ seen: _seen, ...jam }) => jam));
    } catch { /* annonce illisible */ }
  });
  listener.on('error', () => stopBrowsing());
  listener.bind(DISCOVERY_PORT);
}

export function stopBrowsing() {
  listener?.close();
  listener = null;
  nearby.clear();
}

export function join(address: string, port: number, name: string): Promise<void> {
  leaveGuest();
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port }, () => {
      hostSocket = socket;
      write(socket, { type: 'hello', name });
      resolve();
    });
    socket.setTimeout(10_000, () => socket.destroy(new Error('Le Jam ne répond pas.')));
    lines(socket, (message) => send('jam:fromHost', message));
    socket.on('error', (error) => {
      if (!hostSocket) reject(error);
    });
    socket.on('close', () => {
      if (hostSocket === socket) {
        hostSocket = null;
        send('jam:ended');
      }
    });
  });
}

export function toHost(message: unknown) {
  if (hostSocket) write(hostSocket, message);
}

function leaveGuest() {
  const socket = hostSocket;
  hostSocket = null;
  socket?.destroy();
}

export function stop() {
  if (announcer) clearInterval(announcer);
  announcer = null;
  udp?.close();
  udp = null;
  for (const socket of guests.keys()) {
    write(socket, { type: 'ended' });
    socket.end();
  }
  guests = new Map();
  server?.close();
  server = null;
  leaveGuest();
}
