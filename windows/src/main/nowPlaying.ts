import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Server as SocketServer } from 'socket.io';
import { idlePlayback, publicArtwork, type PublishedPlayback } from './publishedPlayback.js';

export const nowPlayingPorts = [10767, 10768];
const toMillis = (seconds: number) => Math.round(seconds * 1000);
const escapeHTML = (text: string) => text.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!);

type RenderCover = (track: NonNullable<PublishedPlayback['track']>, signal: AbortSignal) => Promise<Buffer | undefined>;

export class NowPlaying {
  private server?: Server;
  private sockets?: SocketServer;
  private snapshot = idlePlayback;
  private refreshing?: AbortController;
  private cover?: Buffer;
  private writing = Promise.resolve();
  private revision = 0;
  private lastTimeEvent = 0;
  port?: number;
  error?: string;

  constructor(readonly directory: string, private readonly overlay: Buffer, private readonly placeholder: Buffer,
    private readonly renderCover: RenderCover) {}

  get origin() { return this.port ? 'http://127.0.0.1:' + this.port : undefined; }

  async start(ports = nowPlayingPorts) {
    if (this.server) return;
    this.error = undefined;
    for (const port of ports) {
      const server = createServer((req, res) => this.respond(req, res));
      const listening = await new Promise<boolean>(resolve => {
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (!listening) continue;
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); continue; }
      this.port = address.port;
      this.server = server;
      this.sockets = new SocketServer(server, {
        serveClient: false,
        maxHttpBufferSize: 4096,
        allowRequest: (req, done) => done(null, this.allowed(req)),
      });
      this.sockets.on('connection', socket => {
        const info = this.ciderInfo();
        socket.emit('API:Playback', { type: 'playbackStatus.nowPlayingItemDidChange', data: info });
        socket.emit('API:Playback', { type: 'playbackStatus.playbackStateDidChange', data: info });
      });
      this.refreshCover();
      return;
    }
    this.error = 'Les ports 10767 et 10768 sont indisponibles. Ferme l’application qui les utilise puis réactive Now Playing.';
  }

  async stop() {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this.port = undefined;
    this.refreshing?.abort();
    this.revision++;
    const sockets = this.sockets;
    this.sockets = undefined;
    this.writeExport(true);
    const closed = sockets?.close();
    server.closeAllConnections();
    await Promise.all([closed, this.writing]);
  }

  publish(snapshot: PublishedPlayback) {
    const previous = this.snapshot;
    this.snapshot = snapshot;
    if (!this.server) return;
    const changedTrack = JSON.stringify(previous.track) !== JSON.stringify(snapshot.track);
    const changedState = previous.playing !== snapshot.playing;
    if (changedTrack || changedState || previous.duration !== snapshot.duration) {
      if (changedTrack) this.refreshCover();
      else this.writeExport();
      if (changedTrack) this.broadcast('nowPlayingItemDidChange');
      if (changedState) this.broadcast('playbackStateDidChange');
    }
    if (snapshot.position !== previous.position && Date.now() - this.lastTimeEvent > 850) {
      this.lastTimeEvent = Date.now();
      this.broadcast('playbackTimeDidChange');
    }
  }

  private allowed(req: IncomingMessage) {
    const hosts = ['127.0.0.1:' + this.port, 'localhost:' + this.port];
    if (!hosts.includes(req.headers.host ?? '')) return false;
    return !req.headers.origin || hosts.some(host => 'http://' + host === req.headers.origin);
  }

  private coverURL() { return this.origin + '/cover.png?v=' + this.revision; }

  private ciderInfo() {
    const { track, playing, position, duration } = this.snapshot;
    if (!track) return null;
    return {
      name: track.title, artistName: track.artist, albumName: track.album,
      artwork: { url: publicArtwork(track.artwork) ?? this.coverURL(), width: 600, height: 600 },
      playParams: { id: track.id, kind: 'song' }, durationInMillis: toMillis(duration),
      isPlaying: playing, status: playing, currentPlaybackTime: position,
      remainingTime: Math.max(0, duration - position),
    };
  }

  private broadcast(event: string) {
    this.sockets?.emit('API:Playback', { type: 'playbackStatus.' + event, data: this.ciderInfo() });
  }

  private playingNow() {
    const { track, playing, duration } = this.snapshot;
    return track && playing ? JSON.stringify({
      title: escapeHTML(track.title), artists: [escapeHTML(track.artist)],
      album: escapeHTML(track.album), duration: toMillis(duration),
    }) : 'None';
  }

  private respond(req: IncomingMessage, res: ServerResponse) {
    if (!this.allowed(req)) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const send = (type: string, data: string | Buffer, status = 200) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
      res.end(req.method === 'HEAD' ? undefined : data);
    };
    switch (req.url?.split('?')[0]) {
      case '/obs': return send('text/html; charset=utf-8', this.overlay);
      case '/now-playing': {
        const { track, playing, position, duration } = this.snapshot;
        return send('application/json', JSON.stringify({
          track: track ? { title: track.title, artist: track.artist, album: track.album, artwork: this.coverURL() } : null,
          playing, position, duration,
        }));
      }
      case '/cover.png': return send('image/png', this.cover ?? this.placeholder);
      case '/song_info.json': return send('text/plain; charset=utf-8', this.playingNow());
      case '/now-playing.txt': {
        const track = this.snapshot.playing ? this.snapshot.track : null;
        return send('text/plain; charset=utf-8', track ? [track.artist, track.title].filter(Boolean).join(' — ') : '');
      }
      case '/api/v1/playback/active': return send('text/plain', '', 204);
      case '/api/v1/playback/is-playing': return send('application/json', JSON.stringify({ status: 'ok', is_playing: this.snapshot.playing }));
      case '/api/v1/playback/now-playing': return send('application/json', JSON.stringify({ status: 'ok', info: this.ciderInfo() }));
      default: return send('text/plain', '', 404);
    }
  }

  private refreshCover() {
    this.refreshing?.abort();
    this.cover = undefined;
    this.revision++;
    const track = this.snapshot.track;
    this.writeExport();
    if (!track) return;
    const controller = new AbortController();
    this.refreshing = controller;
    void this.renderCover(track, controller.signal).then(cover => {
      if (controller.signal.aborted || !cover || !this.server) return;
      this.cover = cover;
      this.revision++;
      this.writeExport();
    }).catch(() => undefined);
  }

  private writeExport(clear = false) {
    const info = clear ? 'None' : this.playingNow();
    const cover = info === 'None' ? this.placeholder : this.cover ?? this.placeholder;
    this.writing = this.writing.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const write = async (name: string, data: Buffer | string) => {
        const target = path.join(this.directory, name);
        await writeFile(target + '.tmp', data);
        await rename(target + '.tmp', target);
      };
      await write('cover.png', cover);
      await write('song_info.json', info);
    }).catch(() => { this.error = 'Le dossier PlayingNow est indisponible. La source navigateur reste accessible.'; });
  }
}
