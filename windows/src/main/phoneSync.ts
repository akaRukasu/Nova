// Réception de la bibliothèque de l'iPhone : petit serveur temporaire sur le réseau local,
// protégé par un jeton à usage unique (dans le QR code affiché par Nova pour Windows).
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { localAddresses } from './jam.js';

let server: http.Server | null = null;
let stopTimer: NodeJS.Timeout | null = null;

export function stopReceiving() {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = null;
  server?.close();
  server = null;
}

/** Démarre l'écoute ; renvoie le lien à mettre dans le QR code. */
export function startReceiving(onLibrary: (library: unknown) => { playlists: number; tracks: number }): Promise<{ link: string; address: string }> {
  stopReceiving();
  const token = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      if (request.method !== 'POST' || !request.url?.startsWith('/sync')) {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Nova pour Windows : scanne le QR code avec l’appareil photo de l’iPhone.');
        return;
      }
      if (request.headers['x-nova-token'] !== token) {
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
      request.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const summary = onLibrary(parsed.library ?? parsed);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(summary));
          // Jeton à usage unique : le serveur s'arrête après le transfert.
          setTimeout(stopReceiving, 1000);
        } catch {
          response.writeHead(400);
          response.end();
        }
      });
    });
    server.on('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const port = (server!.address() as { port: number }).port;
      const address = localAddresses()[0] ?? '127.0.0.1';
      const target = `http://${address}:${port}/sync`;
      const link = `nova://sync?u=${encodeURIComponent(target)}&t=${token}&n=${encodeURIComponent(os.hostname())}`;
      // Le QR code reste valable 15 minutes.
      stopTimer = setTimeout(stopReceiving, 15 * 60_000);
      resolve({ link, address: `${address}:${port}` });
    });
  });
}
