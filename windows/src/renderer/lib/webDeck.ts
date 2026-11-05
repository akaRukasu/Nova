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
  }

  get currentTime() { return this.time; }
  set currentTime(value: number) {
    this.time = value;
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

  pause() {
    this.paused = true;
    void call('webplayer:command', this.number, { type: 'pause' });
  }

  removeAttribute(_name: string) {
    this.url = '';
    this.videoId = '';
    this.loaded = false;
    void call('webplayer:command', this.number, { type: 'stop' });
  }

  load() {}

  receive(payload: { type: string; time: number; duration: number; paused: boolean; ad: boolean; videoId: string; expected: string }) {
    // Événement d'un titre précédent ou d'une page qui n'est plus la nôtre : ignoré.
    if (!this.videoId || (payload.expected && payload.expected !== this.videoId)) return;
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
    if (payload.type === 'timeupdate' || payload.type === 'playing') this.time = payload.time;
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
