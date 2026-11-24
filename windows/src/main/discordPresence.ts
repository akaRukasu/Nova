import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { idlePlayback, publicArtwork, type PublishedPlayback } from './publishedPlayback.js';

type PresenceStatus = 'off' | 'missing-id' | 'waiting' | 'ready' | 'active' | 'rejected';
const frame = (opcode: number, data: Buffer) => {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data]);
};
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const label = (value: string, fallback: string) => Array.from(value || fallback).slice(0, 128).join('');

export class DiscordPresence {
  status: PresenceStatus = 'off';
  private clientId = '';
  private socket?: Socket;
  private retry?: ReturnType<typeof setTimeout>;
  private refresh?: ReturnType<typeof setTimeout>;
  private latest = idlePlayback;
  private acknowledged = false;
  private pending?: { nonce: string; active: boolean };
  private last?: { identity: string; start: number; time: number };

  constructor(private readonly connect = (index: number) => createConnection('\\\\.\\pipe\\discord-ipc-' + index)) {}

  configure(enabled: boolean, clientId: string) {
    const next = enabled ? clientId : '';
    if (next && next === this.clientId) return;
    this.close();
    this.clientId = next;
    this.status = enabled ? (next ? 'waiting' : 'missing-id') : 'off';
    if (next) this.open(0);
  }

  publish(snapshot: PublishedPlayback) {
    this.latest = snapshot;
    this.send();
  }

  close() {
    clearTimeout(this.retry);
    clearTimeout(this.refresh);
    const socket = this.socket;
    if (socket && this.acknowledged) {
      socket.end(frame(1, json({ cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: randomUUID() })));
      const timeout = setTimeout(() => socket.destroy(), 500);
      timeout.unref();
    } else socket?.destroy();
    this.socket = undefined;
    this.clientId = '';
    this.acknowledged = false;
    this.pending = undefined;
    this.last = undefined;
    this.status = 'off';
  }

  private open(index: number) {
    const socket = this.connect(index);
    this.socket = socket;
    let buffer = Buffer.alloc(0);
    let connected = false;
    let rejected = false;
    socket.setTimeout(3500, () => socket.destroy());
    socket.on('connect', () => socket.write(frame(0, json({ v: 1, client_id: this.clientId }))));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.acknowledged = false;
      this.pending = undefined;
      this.last = undefined;
      clearTimeout(this.refresh);
      if (rejected) { this.status = 'rejected'; return; }
      this.status = 'waiting';
      if (!connected && index < 9) this.open(index + 1);
      else this.retry = setTimeout(() => this.open(0), 5000);
    });
    socket.on('data', (chunk: Buffer) => {
      if (this.socket !== socket) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const opcode = buffer.readUInt32LE(0), length = buffer.readUInt32LE(4);
        if (length > 1024 * 1024) { socket.destroy(); return; }
        if (buffer.length < 8 + length) return;
        const payload = buffer.subarray(8, 8 + length);
        buffer = buffer.subarray(8 + length);
        if (opcode === 3) { socket.write(frame(4, payload)); continue; }
        if (opcode !== 1 && opcode !== 2) continue;
        try {
          const message = JSON.parse(payload.toString('utf8'));
          if (opcode === 2) {
            rejected = !connected && (message.code === 4000 || message.code === 4002 || message.code === 4006);
            socket.destroy();
            return;
          }
          if (message.evt === 'READY') {
            connected = this.acknowledged = true;
            socket.setTimeout(0);
            this.status = 'ready';
            this.send();
          } else if (message.nonce && this.pending && this.pending.nonce === message.nonce) {
            this.status = message.evt === 'ERROR' ? 'rejected' : this.pending.active ? 'active' : 'ready';
            this.pending = undefined;
          } else if (!connected && message.evt === 'ERROR') {
            rejected = true;
            socket.destroy();
          }
        } catch { socket.destroy(); return; }
      }
    });
  }

  private send() {
    if (!this.socket || !this.acknowledged) return;
    const { track, playing, position, duration } = this.latest;
    const active = playing && track !== null;
    const artwork = publicArtwork(track?.artwork);
    const identity = active ? JSON.stringify([track.id, track.title, track.artist, track.album, artwork, Math.round(duration)]) : '';
    const now = Date.now();
    const start = now - Math.round(position * 1000);
    const previous = this.last;
    if (previous?.identity === identity && (!active || Math.abs(start - previous.start) < 2500)) return;
    clearTimeout(this.refresh);
    if (active && previous?.identity && now - previous.time < 1500) {
      this.refresh = setTimeout(() => this.send(), 1500 - (now - previous.time));
      return;
    }
    if (!active && !previous?.identity) return;
    const activity = active ? {
      type: 2, details: label(track.title, 'Écoute en cours'), state: label(track.artist, 'Artiste inconnu'),
      timestamps: { start, ...(duration > position ? { end: start + Math.round(duration * 1000) } : {}) },
      ...(artwork ? { assets: { large_image: artwork, large_text: label(track.album, track.title) } } : {}),
    } : null;
    this.last = { identity, start, time: now };
    const nonce = randomUUID();
    this.pending = { nonce, active };
    this.socket.write(frame(1, json({ cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce })));
  }
}
