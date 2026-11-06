// Lecteur « web » : même interface qu'un élément audio, mais il pilote le lecteur officiel de
// YouTube Music chargé dans une fenêtre invisible (processus principal).
import { on } from './api';

const call = <T,>(channel: string, ...args: unknown[]) => window.nova.invoke<T>(channel, ...args);
const decks = new Map<number, WebDeck>();

on('webplayer:event', (deck: number, payload: any) => decks.get(deck)?.receive(payload));

export class WebDeck extends EventTarget {
  preload = 'auto';
  paused = true;
  duration = NaN;
  /** Publicité de YouTube en cours (comptes sans Premium). */
  ad = false;
  private time = 0;
  private level = 0.8;
  private videoId = '';
  private url = '';
  private loaded = false;
  private startAt = 0;
  private started = false;
  private lastType = '';
  /** Instant de la dernière position reçue : la position est prolongée entre deux messages (transitions calées). */
  private timeAt = 0;
  private speed = 1;
  private bass = 0;
  private waiting: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly number: number) {
    super();
    decks.set(number, this);
  }

  get src() { return this.url; }
  set src(value: string) {
    this.url = value;
    this.videoId = decodeURIComponent(value.split('/').pop() ?? '');
    this.loaded = false;
    this.startAt = 0;
    this.time = 0;
    this.duration = NaN;
    this.ad = false;
    this.started = false;
  }

  get currentTime() {
    if (this.paused || !this.timeAt) return this.time;
    return this.time + ((performance.now() - this.timeAt) / 1000) * this.speed;
  }
  set currentTime(value: number) {
    this.time = value;
    this.timeAt = 0;
    if (this.loaded) void call('webplayer:command', this.number, { type: 'seek', value });
    else this.startAt = value;
  }

  get volume() { return this.level; }
  set volume(value: number) {
    this.level = value;
    void call('webplayer:command', this.number, { type: 'volume', value });
  }

  play(): Promise<void> {
    if (!this.videoId) return Promise.reject(new Error('Aucun titre'));
    this.waiting?.reject(new DOMException('Remplacé', 'AbortError') as unknown as Error);
    const promise = new Promise<void>((resolve, reject) => {
      // Chargement de la page de YouTube Music : jusqu'à 40 s (première fois, consentement…).
      const timer = setTimeout(() => { this.waiting = null; reject(new Error('Le lecteur YouTube Music ne répond pas')); }, 40_000);
      this.waiting = { resolve, reject, timer };
    });
    if (!this.loaded) {
      this.loaded = true;
      void call('webplayer:load', this.number, this.videoId, this.startAt, this.level);
    } else {
      void call('webplayer:command', this.number, { type: 'play' });
    }
    return promise;
  }

  /** Tempo (hauteur conservée) : AutoMix cale le titre suivant sur celui qui se termine. */
  get playbackRate() { return this.speed; }
  set playbackRate(value: number) {
    if (Math.abs(value - this.speed) < 0.0005) return;
    if (this.timeAt) { this.time = this.currentTime; this.timeAt = performance.now(); }
    this.speed = value;
    void call('webplayer:command', this.number, { type: 'rate', value });
  }

  /** Basses (dB, 0 = inchangées) : échange des basses pendant les transitions. */
  setBass(value: number) {
    if (value === this.bass || (Math.abs(value - this.bass) < 0.5 && value !== 0)) return;
    this.bass = value;
    void call('webplayer:command', this.number, { type: 'bass', value });
  }

  pause() {
    this.time = this.currentTime;
    this.timeAt = 0;
    this.paused = true;
    void call('webplayer:command', this.number, { type: 'pause' });
  }

  removeAttribute(_name: string) {
    this.speed = 1;
    this.bass = 0;
    this.url = '';
    this.videoId = '';
    this.loaded = false;
    void call('webplayer:command', this.number, { type: 'stop' });
  }

  load() {}

  receive(payload: { type: string; time: number; duration: number; paused: boolean; ad: boolean; videoId: string; expected: string }) {
    // Événement d'un titre précédent ou d'une page qui n'est plus la nôtre : ignoré.
    if (!this.videoId || (payload.expected && payload.expected !== this.videoId)) return;
    // Mesures du son (AutoMix) : transmises telles quelles.
    if (payload.type === 'measures') {
      if (!payload.videoId || payload.videoId === this.videoId) this.dispatchEvent(new CustomEvent('measures', { detail: payload }));
      return;
    }
    const wasAd = this.ad;
    this.ad = payload.ad;
    if (this.ad !== wasAd) this.dispatchEvent(new Event('adchange'));
    if (payload.ad) return;
    if (payload.videoId && payload.videoId !== this.videoId) return;
    this.paused = payload.paused;
    if (payload.duration) {
      const first = !Number.isFinite(this.duration);
      this.duration = payload.duration;
      if (first) this.dispatchEvent(new Event('loadedmetadata'));
    }
    if (payload.type === 'timeupdate' || payload.type === 'playing') {
      this.time = payload.time;
      this.timeAt = performance.now();
    }
    // La position avance alors qu'on n'a pas vu le début de la lecture : elle a bien démarré.
    if (payload.type === 'timeupdate' && !payload.paused && (this.waiting || this.lastType === 'pause' || !this.started)) {
      payload = { ...payload, type: 'playing' };
    }
    this.lastType = payload.type;
    if (payload.type === 'playing') this.started = true;
    if (payload.type === 'playing' && this.waiting) {
      clearTimeout(this.waiting.timer);
      this.waiting.resolve();
      this.waiting = null;
    }
    if (payload.type === 'error' && this.waiting) {
      clearTimeout(this.waiting.timer);
      this.waiting.reject(new Error('Erreur du lecteur YouTube Music'));
      this.waiting = null;
    }
    if (['timeupdate', 'playing', 'waiting', 'ended', 'error'].includes(payload.type)) this.dispatchEvent(new Event(payload.type));
  }
}
