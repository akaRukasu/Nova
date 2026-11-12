// Synchronisation avec Nova sur l'iPhone, sur le réseau local.
// Association une fois (QR code) ; ensuite le PC reste à l'écoute tant que Nova est ouvert et
// s'annonce en Bonjour (« _nova-sync._tcp ») : l'iPhone le retrouve et envoie ses changements seul.
import { Bonjour, type Service } from 'bonjour-service';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { localAddresses } from './jam.js';
import type { HistorySnapshot } from '../shared/historySync.js';

export interface Pairing {
  pcId: string;
  token: string;
  paired: boolean;
  phoneName?: string;
  lastSync?: number;
}

const PREFERRED_PORT = 47822;
let server: http.Server | null = null;
let bonjour: Bonjour | null = null;
let service: Service | null = null;
let port = 0;
let pairing: Pairing;
let pairingFile = '';
let onLibrary: (library: unknown, phone: string) => { playlists: number; tracks: number } = () => ({ playlists: 0, tracks: 0 });
// Télécommande depuis l'iPhone (comme Spotify Connect) : état de lecture et commandes.
let remoteState: unknown = null;
let onCommand: (command: unknown) => void = () => {};

export function setRemoteState(state: unknown) {
  remoteState = state;
}

export function getRemoteState() {
  return remoteState;
}

export function setRemoteHandler(handler: (command: unknown) => void) {
  onCommand = handler;
}

function readBody(request: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) request.destroy(new Error('trop gros'));
      else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function savePairing() {
  await fs.writeFile(pairingFile, JSON.stringify(pairing));
}

export function currentPairing(): Pairing {
  return pairing;
}

export async function startSyncServer(dataDir: string, handler: typeof onLibrary,
  exchangeHistory?: (incoming: HistorySnapshot) => Promise<HistorySnapshot>) {
  onLibrary = handler;
  pairingFile = path.join(dataDir, 'pairing.json');
  try {
    pairing = JSON.parse(await fs.readFile(pairingFile, 'utf8'));
  } catch {
    pairing = { pcId: crypto.randomUUID(), token: crypto.randomBytes(16).toString('hex'), paired: false };
    await fs.mkdir(dataDir, { recursive: true });
    await savePairing();
  }
  server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/status')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ app: 'nova-windows', pcId: pairing.pcId, name: os.hostname() }));
      return;
    }
    if (request.method === 'POST' && request.url === '/history' && exchangeHistory) {
      if (request.headers['x-nova-token'] !== pairing.token) {
        response.writeHead(403).end();
        return;
      }
      void readBody(request, 4_000_000).then(async (body) => {
        const incoming: HistorySnapshot = JSON.parse(body);
        if (incoming?.version !== 1 || !Array.isArray(incoming.entries)) {
          response.writeHead(400).end();
          return;
        }
        const data = JSON.stringify(await exchangeHistory(incoming));
        const phone = String(request.headers['x-nova-device'] ?? 'Mobile');
        if (!pairing.paired || pairing.phoneName !== phone || Date.now() - (pairing.lastSync ?? 0) >= 60_000) {
          pairing = { ...pairing, paired: true, phoneName: phone, lastSync: Date.now() };
          await savePairing().catch(() => undefined);
        }
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }).end(data);
      }).catch(() => response.writeHead(503).end());
      return;
    }
    if (request.url?.startsWith('/remote/')) {
      if (request.headers['x-nova-token'] !== pairing.token) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(remoteState ?? { name: os.hostname(), track: null, queue: [], playing: false, time: 0, duration: 0, volume: 0.8 }));
        return;
      }
      void readBody(request, 20_000_000).then((body) => {
        onCommand(JSON.parse(body));
        // L'interface applique la commande puis publie le nouvel état : on le renvoie un instant après.
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(remoteState ?? {}));
        }, 250);
      }).catch(() => {
        response.writeHead(400);
        response.end();
      });
      return;
    }
    if (request.method !== 'POST' || !request.url?.startsWith('/sync')) {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Nova pour Windows');
      return;
    }
    if (request.headers['x-nova-token'] !== pairing.token) {
      response.writeHead(403);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 300_000_000) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', async () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const phone = String(request.headers['x-nova-device'] ?? 'iPhone');
        const summary = onLibrary(parsed.library ? { ...parsed.library, shared: parsed.shared } : parsed, phone);
        pairing = { ...pairing, paired: true, phoneName: phone, lastSync: Date.now() };
        await savePairing();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(summary));
      } catch {
        response.writeHead(400);
        response.end();
      }
    });
  });
  // Port fixe si possible (l'iPhone le retrouve même sans Bonjour), sinon un port libre.
  await new Promise<void>((resolve) => {
    server!.once('error', () => server!.listen(0, '0.0.0.0', resolve));
    server!.listen(PREFERRED_PORT, '0.0.0.0', resolve);
  });
  port = (server.address() as { port: number }).port;
  try {
    bonjour = new Bonjour();
    service = bonjour.publish({ name: `Nova ${os.hostname()}`.slice(0, 60), type: 'nova-sync', port, txt: { id: pairing.pcId } });
  } catch {
    // Bonjour indisponible : l'adresse mémorisée par l'iPhone sert de secours.
  }
}

/** Lien du QR code d'association (le jeton reste le même tant qu'on ne dissocie pas). */
export function pairingLink(): { link: string; address: string } {
  const address = localAddresses()[0] ?? '127.0.0.1';
  const target = `http://${address}:${port}/sync`;
  const query = new URLSearchParams({ u: target, t: pairing.token, n: os.hostname(), id: pairing.pcId });
  return { link: `nova://sync?${query.toString()}`, address: `${address}:${port}` };
}

/** Dissocier : nouveau jeton, l'ancien iPhone ne peut plus envoyer. */
export async function unpair() {
  pairing = { pcId: pairing.pcId, token: crypto.randomBytes(16).toString('hex'), paired: false };
  await savePairing();
}

export function stopSyncServer() {
  service?.stop?.();
  bonjour?.destroy();
  server?.close();
}
