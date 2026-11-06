// Lecteur : file d'attente, aléatoire, répétition, AutoMix / fondu enchaîné (deux lecteurs audio),
// reprise automatique si le flux coupe, commandes multimédias de Windows, minuterie.
import type { Track } from '../../shared/types';
import {
  analyzeMeasures, analyzeSamples, bassSwap, gainFor, mixVolumes, planMix, saveAnalysis, savedAnalysis,
  type MixPlan, type TrackAnalysis,
} from './analysis';
import { api, isAndroid, on } from './api';
import { library, notify, recordPlay, shuffle as shuffled, updateArtwork } from './library';
import { Store } from './store';
import { WebDeck } from './webDeck';

type Deck = HTMLAudioElement | WebDeck;
export type EngineMode = 'direct' | 'web';

export type RepeatMode = 'off' | 'all' | 'one';

export interface PlayerState {
  queue: Track[];
  index: number;
  playing: boolean;
  loading: boolean;
  shuffled: boolean;
  repeat: RepeatMode;
  volume: number;
  transitioning: boolean;
  /** Publicité de YouTube en cours (lecteur officiel, compte sans Premium). */
  ad: boolean;
  mode: EngineMode;
  sleepAt?: number;
  error?: string;
}

export const playerState = new Store<PlayerState>({
  queue: [], index: 0, playing: false, loading: false, shuffled: false, repeat: 'off',
  volume: Number(localStorage.getItem('volume') ?? 0.8), transitioning: false, ad: false,
  mode: isAndroid ? 'web' : (localStorage.getItem('engineMode') as EngineMode) ?? 'direct',
});

/** Position et durée, à part : elles changent quatre fois par seconde (seul le lecteur s'en sert). */
export const timeState = new Store<{ time: number; duration: number }>({ time: 0, duration: 0 });
const setTime = (change: Partial<{ time: number; duration: number }>) => timeState.set((s) => ({ ...s, ...change }));

export const currentTrack = () => {
  const { queue, index } = playerState.get();
  return queue[index];
};

const set = (change: Partial<PlayerState>) => playerState.set((s) => ({ ...s, ...change }));
const normalize = () => library.get().settings.normalizeVolume !== false;

/** Durées réelles connues (les flux annoncent parfois une durée fausse). */
const durations = new Map<string, number>(Object.entries(JSON.parse(localStorage.getItem('durations') ?? '{}')));
function rememberDuration(id: string, seconds: number) {
  if (!seconds || durations.get(id) === seconds) return;
  durations.set(id, seconds);
  if (durations.size > 3000) durations.delete(durations.keys().next().value as string);
  localStorage.setItem('durations', JSON.stringify(Object.fromEntries(durations)));
}

class Engine {
  private decks: Deck[] = [];
  private active = 0;
  private unshuffled: Track[] | null = null;
  private fadeTimer: ReturnType<typeof setInterval> | undefined;
  private endHandled = false;
  private recoveries = 0;
  private recoveryFor = '';
  private stalledSince = 0;
  private prefetchTimer: ReturnType<typeof setTimeout> | undefined;
  private sleepTimer: ReturnType<typeof setTimeout> | undefined;
  /** Jam : un invité qui écoute aussi suit l'hôte, sans transitions ni radio. */
  followingJam = false;
  /** Égaliseur de volume du titre en cours (1 = inchangé). */
  private gain = 1;
  /** Mesures du son reçues du lecteur de YouTube Music, par titre (AutoMix). */
  private live = new Map<string, { rms: Float32Array; flux: Float32Array; seen: Uint8Array; frameRate: number; count: number; duration: number }>();
  private plan: MixPlan | null = null;
  private planQuality = 0;
  private planCheckedAt = 0;
  /** Transition préparée : titre suivant chargé, calé sur son premier temps, départ programmé. */
  private pending: { plan: MixPlan; deck: Deck; timer?: ReturnType<typeof setTimeout> } | null = null;
  private tempoTimer: ReturnType<typeof setInterval> | undefined;
  private analyzing = new Set<string>();
  private analysisChain: Promise<unknown> = Promise.resolve();

  constructor() {
    this.createDecks(playerState.get().mode);
    // Surveillance : flux bloqué plus de 10 s → relancé au même endroit (lien neuf si besoin).
    setInterval(() => {
      if (this.stalledSince && playerState.get().playing && !(this.deck as WebDeck).ad && Date.now() - this.stalledSince > 10_000) {
        this.recover('flux bloqué');
      }
    }, 2000);
    this.setupMediaSession();
    this.restoreSession();
    window.addEventListener('beforeunload', () => this.saveSession());
    setInterval(() => this.saveSession(), 15_000);
  }

  /** Lecture directe (flux audio) ou par le lecteur officiel de YouTube Music. */
  private createDecks(mode: EngineMode) {
    this.decks.forEach((deck) => { deck.pause(); deck.removeAttribute('src'); });
    this.decks = mode === 'web' ? [new WebDeck(0), new WebDeck(1)] : [new Audio(), new Audio()];
    this.decks.forEach((deck, number) => {
      deck.preload = 'auto';
      deck.volume = playerState.get().volume;
      deck.addEventListener('timeupdate', () => number === this.active && this.tick());
      deck.addEventListener('ended', () => number === this.active && this.trackEnded());
      deck.addEventListener('playing', () => {
        if (number !== this.active) return;
        this.stalledSince = 0;
        set({ loading: false, playing: true });
      });
      deck.addEventListener('waiting', () => number === this.active && (this.stalledSince ||= Date.now()));
      deck.addEventListener('error', () => number === this.active && this.recover('erreur de flux'));
      deck.addEventListener('loadedmetadata', () => {
        if (number !== this.active) return;
        const track = currentTrack();
        if (track && !track.duration && !durations.get(track.id) && Number.isFinite(deck.duration)) setTime({ duration: deck.duration });
      });
      deck.addEventListener('adchange', () => number === this.active && set({ ad: (deck as WebDeck).ad }));
      deck.addEventListener('measures', (event) => this.collect((event as CustomEvent).detail));
    });
  }

  /** Change de moteur et relance le titre en cours au même endroit. */
  setMode(mode: EngineMode, restart = true) {
    if (isAndroid) mode = 'web';
    if (mode === playerState.get().mode && this.decks.length) return;
    const wasPlaying = playerState.get().playing;
    const position = timeState.get().time;
    localStorage.setItem('engineMode', mode);
    this.finishFade();
    this.createDecks(mode);
    this.active = 0;
    set({ mode, ad: false });
    if (restart && currentTrack()) this.load(position, !wasPlaying);
  }

  private get deck() {
    return this.decks[this.active];
  }

  // MARK: Commandes

  play(tracks: Track[], start = 0, shuffle = false) {
    if (!tracks.length) return;
    if (shuffle) {
      this.unshuffled = tracks;
      const first = tracks[start] && start > 0 ? [tracks[start]] : [];
      const rest = shuffled(tracks.filter((_, i) => !(first.length && i === start)));
      set({ queue: [...first, ...rest], index: 0, shuffled: true });
    } else {
      this.unshuffled = null;
      set({ queue: tracks, index: Math.min(Math.max(start, 0), tracks.length - 1), shuffled: false });
    }
    this.load();
    if (playerState.get().queue.length - playerState.get().index <= 1) void this.extendWithRadio();
  }

  startRadio(track: Track) {
    this.play([track]);
  }

  playNext(track: Track) {
    const { queue, index } = playerState.get();
    if (!queue.length) return this.play([track]);
    const rest = queue.filter((t, i) => i <= index || t.id !== track.id);
    rest.splice(index + 1, 0, track);
    set({ queue: rest });
  }

  enqueue(tracks: Track[]) {
    if (!tracks.length) return;
    if (!playerState.get().queue.length) return this.play(tracks);
    set({ queue: [...playerState.get().queue, ...tracks] });
  }

  removeFromQueue(position: number) {
    const { queue, index } = playerState.get();
    if (position === index) return;
    set({ queue: queue.filter((_, i) => i !== position), index: position < index ? index - 1 : index });
  }

  moveInQueue(from: number, to: number) {
    const { queue, index } = playerState.get();
    const next = [...queue];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const current = queue[index];
    set({ queue: next, index: next.indexOf(current) });
  }

  jumpTo(position: number) {
    set({ index: position });
    this.load();
  }

  toggle() {
    playerState.get().playing ? this.pause() : this.resume();
  }

  resume() {
    if (!currentTrack()) return;
    if (!this.deck.src) return this.load(timeState.get().time);
    void this.deck.play().catch(() => this.recover('reprise'));
    set({ playing: true });
  }

  pause() {
    this.finishFade();
    this.deck.pause();
    set({ playing: false });
    this.saveSession();
  }

  next(manual = true) {
    const { queue, index, repeat } = playerState.get();
    if (index + 1 >= queue.length) {
      if (repeat === 'all' && queue.length) {
        set({ index: 0 });
        return this.load();
      }
      void this.extendWithRadio(true);
      return;
    }
    // AutoMix : même au passage manuel, les deux titres se fondent brièvement.
    const transition = library.get().settings.transition;
    if (manual && transition !== 'off' && playerState.get().playing && !this.followingJam) {
      return this.beginTransition(3);
    }
    set({ index: index + 1 });
    this.load();
  }

  previous() {
    const { index } = playerState.get();
    if (timeState.get().time > 3 || index === 0) return this.seek(0);
    set({ index: index - 1 });
    this.load();
  }

  seek(seconds: number) {
    this.finishFade();
    const target = Math.max(0, seconds);
    if (target < this.expectedDuration() - 1) this.endHandled = false;
    this.deck.currentTime = target;
    setTime({ time: target });
  }

  setVolume(volume: number) {
    localStorage.setItem('volume', String(volume));
    set({ volume });
    if (!this.fadeTimer) this.deck.volume = volume * this.gain;
  }

  toggleShuffle() {
    const { queue, index, shuffled: isShuffled } = playerState.get();
    const current = queue[index];
    if (!current) return;
    if (isShuffled) {
      const original = this.unshuffled ?? queue;
      const extra = queue.filter((t) => !original.some((o) => o.id === t.id));
      const restored = [...original, ...extra];
      set({ queue: restored, index: Math.max(0, restored.findIndex((t) => t.id === current.id)), shuffled: false });
      this.unshuffled = null;
    } else {
      this.unshuffled = queue;
      const rest = shuffled(queue.filter((_, i) => i !== index));
      set({ queue: [...queue.slice(0, index), current, ...rest.filter((t) => !queue.slice(0, index).includes(t))], shuffled: true });
    }
  }

  cycleRepeat() {
    const order: RepeatMode[] = ['off', 'all', 'one'];
    set({ repeat: order[(order.indexOf(playerState.get().repeat) + 1) % 3] });
  }

  setSleepTimer(minutes: number | null) {
    clearTimeout(this.sleepTimer);
    if (!minutes) return set({ sleepAt: undefined });
    const at = Date.now() + minutes * 60_000;
    set({ sleepAt: at });
    this.sleepTimer = setTimeout(() => {
      this.pause();
      set({ sleepAt: undefined });
    }, minutes * 60_000);
  }

  // MARK: Jam

  followJam(queue: Track[], index: number, position: number, playing: boolean) {
    const target = queue[index];
    if (!target) return;
    if (currentTrack()?.id !== target.id) {
      set({ queue, index });
      this.load(position, !playing);
      return;
    }
    set({ queue, index });
    if (playerState.get().loading) return;
    if (Math.abs(this.deck.currentTime - position) > 1.5) this.deck.currentTime = position;
    if (playing && this.deck.paused) this.resume();
    if (!playing && !this.deck.paused) this.pause();
  }

  // MARK: Chargement

  private expectedDuration() {
    const track = currentTrack();
    const reported = Number.isFinite(this.deck.duration) ? this.deck.duration : 0;
    return (track && (track.duration ?? durations.get(track.id))) || timeState.get().duration || reported;
  }

  private load(startAt = 0, paused = false) {
    const track = currentTrack();
    if (!track) return;
    this.finishFade();
    clearInterval(this.tempoTimer);
    this.endHandled = false;
    this.stalledSince = 0;
    const known = track.duration ?? durations.get(track.id);
    set({ loading: true, error: undefined });
    setTime({ time: startAt, duration: known ?? 0 });
    if (!known) void this.fetchDuration(track);
    if (!track.square) void this.resolveArtwork(track);
    const deck = this.deck;
    this.gain = gainFor(savedAnalysis(track.id), normalize());
    deck.playbackRate = 1;
    deck.volume = playerState.get().volume * this.gain;
    deck.src = `nova-stream://audio/${encodeURIComponent(track.id)}`;
    if (startAt > 1) deck.currentTime = startAt;
    if (paused) {
      set({ loading: false, playing: false });
    } else {
      void deck.play().then(() => this.started(track)).catch((error) => {
        if (error?.name !== 'AbortError') this.recover('démarrage');
      });
    }
    this.updateMediaSession();
    this.saveSession();
  }

  private started(track: Track) {
    if (currentTrack()?.id !== track.id) return;
    set({ playing: true, loading: false });
    recordPlay(track);
    this.updateMediaSession();
    // Titre suivant préparé après 15 s (une seule extraction à la fois, côté processus principal).
    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = setTimeout(() => {
      const { queue, index } = playerState.get();
      const next = queue[index + 1];
      if (next) void api.prefetch(next.id);
      // AutoMix (lecture directe) : le titre en cours et le suivant sont analysés en arrière-plan.
      if (library.get().settings.transition !== 'off') {
        this.analyzeFile(track.id);
        if (next) setTimeout(() => this.analyzeFile(next.id), 10_000);
      }
    }, 15_000);
  }

  /** Durée exacte donnée par YouTube Music dans la radio du titre (premier élément = le titre). */
  private async fetchDuration(track: Track) {
    const radio = await api.radio(track.id).catch(() => [] as Track[]);
    for (const item of radio) if (item.duration) rememberDuration(item.id, item.duration);
    const found = radio.find((t) => t.id === track.id)?.duration;
    if (found && currentTrack()?.id === track.id) setTime({ duration: found });
  }

  private async resolveArtwork(track: Track) {
    const artwork = await api.squareArtwork(track.id).catch(() => undefined);
    if (!artwork) return;
    set({ queue: playerState.get().queue.map((t) => (t.id === track.id ? { ...t, artwork, square: true } : t)) });
    updateArtwork(track.id, artwork);
    this.updateMediaSession();
  }

  private async extendWithRadio(thenAdvance = false) {
    const current = currentTrack();
    if (!current || this.followingJam) return;
    if (thenAdvance && !library.get().settings.autoplayRadio) {
      this.pause();
      this.seek(0);
      return;
    }
    const radio = await api.radio(current.id).catch(() => [] as Track[]);
    const known = new Set(playerState.get().queue.map((t) => t.id));
    const fresh = radio.filter((t) => !known.has(t.id));
    if (!fresh.length) return;
    set({ queue: [...playerState.get().queue, ...fresh] });
    if (thenAdvance && currentTrack()?.id === current.id) this.next(false);
  }

  // MARK: Fin du titre, transitions

  private tick() {
    const deck = this.deck;
    const time = deck.currentTime;
    setTime({ time });
    const expected = this.expectedDuration();
    if (expected > 0 && Math.abs(timeState.get().duration - expected) > 0.5) setTime({ duration: expected });
    const settings = library.get().settings;
    const { queue, index, repeat, playing } = playerState.get();
    const canMix = playing && !this.fadeTimer && !this.pending && repeat !== 'one' && index + 1 < queue.length && !this.followingJam
      && !(this.deck as WebDeck).ad && expected > 30;
    // AutoMix : transition préparée d'après l'analyse des deux titres (tempo, temps, fin), calée sur un temps.
    if (canMix && settings.transition === 'automix') {
      this.refreshPlan();
      const plan = this.plan;
      const lead = this.deck instanceof WebDeck ? 12 : 2.5;
      if (plan && plan.outgoingId === queue[index].id && plan.incomingId === queue[index + 1].id
        && time >= plan.start - lead && time < plan.start + plan.duration * 0.5) {
        return this.prepareMix(plan);
      }
    }
    // Fondu enchaîné : il se termine avec le dernier son entendu (silence de fin ignoré quand le titre est analysé).
    if (canMix && settings.transition === 'crossfade') {
      const fade = settings.crossfadeSeconds;
      const known = savedAnalysis(queue[index].id);
      const end = known && known.coverage >= 0.95 ? known.audibleEnd : expected;
      if (end > fade * 3 && time >= end - fade && time < end - 0.5) return this.beginTransition(fade);
    }
    // Flux plus long que le titre (durée annoncée fausse) : on passe au suivant nous-mêmes.
    if (expected > 0 && playing && !this.endHandled && time >= expected - 0.3) this.trackEnded();
  }

  private trackEnded() {
    if (this.endHandled) return;
    this.endHandled = true;
    if (playerState.get().repeat === 'one') {
      this.endHandled = false;
      this.deck.currentTime = 0;
      void this.deck.play();
      return;
    }
    this.next(false);
  }

  private beginTransition(seconds: number) {
    this.cancelPending();
    const { queue, index } = playerState.get();
    const nextTrack = queue[index + 1];
    if (!nextTrack) return;
    this.endHandled = true;
    const outgoing = this.deck;
    this.active = 1 - this.active;
    const incoming = this.deck;
    incoming.volume = 0;
    incoming.playbackRate = 1;
    incoming.src = `nova-stream://audio/${encodeURIComponent(nextTrack.id)}`;
    const outgoingGain = this.gain;
    this.gain = gainFor(savedAnalysis(nextTrack.id), normalize());
    const incomingGain = this.gain;
    set({ index: index + 1, transitioning: true, loading: true });
    setTime({ time: 0, duration: nextTrack.duration ?? durations.get(nextTrack.id) ?? 0 });
    if (!nextTrack.duration && !durations.get(nextTrack.id)) void this.fetchDuration(nextTrack);
    if (!nextTrack.square) void this.resolveArtwork(nextTrack);
    this.endHandled = false;
    void incoming.play().then(() => this.started(nextTrack)).catch(() => undefined);
    const automix = library.get().settings.transition === 'automix';
    const volume = playerState.get().volume;
    const smooth = (x: number) => { const v = Math.min(Math.max(x, 0), 1); return v * v * (3 - 2 * v); };
    const startedAt = Date.now();
    clearInterval(this.fadeTimer);
    this.fadeTimer = setInterval(() => {
      const t = Math.min((Date.now() - startedAt) / (seconds * 1000), 1);
      // AutoMix (DJ) : le suivant monte pendant que l'autre tient, puis celui-ci s'efface.
      const [inVolume, outVolume] = automix
        ? [smooth(t / 0.55), 1 - smooth((t - 0.35) / 0.65)]
        : [Math.sin((t * Math.PI) / 2), Math.cos((t * Math.PI) / 2)];
      incoming.volume = volume * incomingGain * inVolume;
      outgoing.volume = volume * outgoingGain * outVolume;
      if (t >= 1) this.finishFade();
    }, 50);
    this.fadingOut = outgoing;
    this.updateMediaSession();
  }

  private fadingOut: Deck | null = null;

  private finishFade() {
    clearInterval(this.fadeTimer);
    this.fadeTimer = undefined;
    if (this.fadingOut) {
      this.fadingOut.pause();
      this.fadingOut.removeAttribute('src');
      this.fadingOut.load();
      this.fadingOut = null;
    }
    this.cancelPending();
    if (this.deck instanceof WebDeck) this.deck.setBass(0);
    this.deck.volume = playerState.get().volume * this.gain;
    if (playerState.get().transitioning) set({ transitioning: false });
  }

  // MARK: AutoMix calé sur le tempo

  /** Mesures du son envoyées par le lecteur de YouTube Music pendant l'écoute. */
  private collect(detail: { videoId?: string; expected?: string; frameRate: number; frames: [number, number, number][] }) {
    const id = detail.videoId || detail.expected;
    if (!id || !detail.frameRate) return;
    let entry = this.live.get(id);
    if (!entry || entry.frameRate !== detail.frameRate) {
      const track = playerState.get().queue.find((t) => t.id === id);
      const duration = track?.duration ?? durations.get(id) ?? 0;
      const size = Math.ceil(((duration || 900) + 5) * detail.frameRate);
      entry = { rms: new Float32Array(size), flux: new Float32Array(size), seen: new Uint8Array(size), frameRate: detail.frameRate, count: 0, duration };
      this.live.set(id, entry);
      if (this.live.size > 4) this.live.delete(this.live.keys().next().value as string);
    }
    for (const [time, rms, flux] of detail.frames) {
      const i = Math.round(time * entry.frameRate);
      if (i < 0 || i >= entry.rms.length) continue;
      if (!entry.seen[i]) { entry.seen[i] = 1; entry.count++; }
      entry.rms[i] = rms;
      entry.flux[i] = flux;
    }
  }

  /** Analyse d'après l'écoute (partielle tant que le titre n'a pas été entendu en entier). */
  private liveAnalysis(id: string): TrackAnalysis | undefined {
    const entry = this.live.get(id);
    if (!entry || entry.count < entry.frameRate * 40) return undefined;
    const duration = entry.duration || durations.get(id) || entry.rms.length / entry.frameRate - 5;
    const frames = Math.min(entry.rms.length, Math.ceil(duration * entry.frameRate));
    const coverage = Math.min(1, entry.count / frames);
    let last = frames - 1;
    while (last > 0 && !entry.seen[last]) last--;
    const end = coverage >= 0.95 ? frames : last + 1;
    return analyzeMeasures(entry.rms.subarray(0, end), entry.flux.subarray(0, end), entry.frameRate, duration, coverage);
  }

  /** Lecture directe : le fichier complet est analysé une fois (en arrière-plan, un titre à la fois). */
  private analyzeFile(id: string) {
    if (playerState.get().mode !== 'direct' || savedAnalysis(id) || this.analyzing.has(id)) return;
    this.analyzing.add(id);
    this.analysisChain = this.analysisChain.then(async () => {
      try {
        const response = await fetch(`nova-stream://audio/${encodeURIComponent(id)}`);
        if (!response.ok) return;
        const context = new OfflineAudioContext(1, 1, 11025);
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        const mono = new Float32Array(buffer.length);
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          const channel = buffer.getChannelData(c);
          for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / buffer.numberOfChannels;
        }
        saveAnalysis(id, analyzeSamples(mono, buffer.sampleRate));
        this.planCheckedAt = 0;
      } catch {
        // Analyse impossible : la transition se fera sans calage.
      } finally {
        this.analyzing.delete(id);
      }
    });
  }

  /** Plan de la prochaine transition, revu toutes les 5 s au plus (analyses plus complètes entre-temps). */
  private refreshPlan() {
    if (Date.now() - this.planCheckedAt < 5000) return;
    this.planCheckedAt = Date.now();
    const { queue, index } = playerState.get();
    const current = queue[index], next = queue[index + 1];
    // Titres entendus en entier : leur analyse est gardée pour les prochaines fois.
    for (const [id, entry] of this.live) {
      if (id === current?.id) continue;
      const analysis = this.liveAnalysis(id);
      if (analysis && analysis.coverage >= 0.9) saveAnalysis(id, analysis);
      if (entry) this.live.delete(id);
    }
    if (!current || !next) { this.plan = null; return; }
    const expected = this.expectedDuration();
    const nearEnd = expected - timeState.get().time < 90;
    const a = savedAnalysis(current.id) ?? (nearEnd ? this.liveAnalysis(current.id) : undefined);
    const b = savedAnalysis(next.id);
    const quality = (a ? 2 : 0) + (b ? 1 : 0) + (a && a.coverage >= 0.95 ? 4 : 0);
    if (this.plan && this.plan.outgoingId === current.id && this.plan.incomingId === next.id && quality <= this.planQuality) return;
    // Titre inconnu : repères par défaut (pas de calage du tempo, fin d'après la durée).
    const unknown = (duration: number): TrackAnalysis => ({
      version: 1, duration, beatClarity: 0, beatNearStart: 0, beatNearEnd: 0, audibleStart: 0, audibleEnd: duration,
      introEnd: 0, outroStart: duration, loudness: -20, coverage: 0,
    });
    if (!expected) return;
    this.plan = planMix(current.id, a ?? unknown(expected), next.id, b ?? unknown(next.duration ?? durations.get(next.id) ?? 240), normalize());
    this.planQuality = quality;
  }

  /** Charge le titre suivant à l'avance (son coupé, sur son premier temps) et programme son départ. */
  private prepareMix(plan: MixPlan) {
    const { queue, index } = playerState.get();
    const next = queue[index + 1];
    if (!next || next.id !== plan.incomingId) return;
    const outgoing = this.deck;
    const incoming = this.decks[1 - this.active];
    const pending: NonNullable<typeof this.pending> = { plan, deck: incoming };
    this.pending = pending;
    incoming.volume = 0;
    incoming.playbackRate = 1;
    incoming.src = `nova-stream://audio/${encodeURIComponent(next.id)}`;
    incoming.currentTime = plan.incomingOffset;
    const schedule = () => {
      if (this.pending !== pending) return;
      const delay = Math.max(0, (plan.start - outgoing.currentTime) / (outgoing.playbackRate || 1));
      pending.timer = setTimeout(() => this.commitMix(pending), delay * 1000);
    };
    if (incoming instanceof WebDeck) {
      // Lecteur de YouTube Music : page chargée à l'avance, puis arrêtée sur le premier temps.
      incoming.play().then(() => {
        if (this.pending !== pending) return;
        incoming.pause();
        incoming.currentTime = plan.incomingOffset;
        schedule();
      }).catch(() => { if (this.pending === pending) this.cancelPending(); });
    } else {
      schedule();
    }
  }

  private cancelPending() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.deck.pause();
    pending.deck.removeAttribute('src');
  }

  /** Départ du titre suivant sur un temps du titre en cours, mélange, échange des basses, calage continu. */
  private commitMix(pending: NonNullable<typeof this.pending>) {
    if (this.pending !== pending) return;
    this.pending = null;
    const { plan, deck: incoming } = pending;
    const { queue, index, playing } = playerState.get();
    const next = queue[index + 1];
    if (!playing || queue[index]?.id !== plan.outgoingId || next?.id !== plan.incomingId) {
      incoming.pause();
      incoming.removeAttribute('src');
      return;
    }
    const outgoing = this.deck;
    const late = Math.max(0, outgoing.currentTime - plan.start);
    if (late > 0.05) incoming.currentTime = plan.incomingOffset + late * plan.incomingRate;
    incoming.playbackRate = plan.incomingRate;
    this.endHandled = true;
    this.active = 1 - this.active;
    set({ index: index + 1, transitioning: true });
    setTime({ time: plan.incomingOffset, duration: next.duration ?? durations.get(next.id) ?? 0 });
    if (!next.duration && !durations.get(next.id)) void this.fetchDuration(next);
    if (!next.square) void this.resolveArtwork(next);
    this.endHandled = false;
    void incoming.play().then(() => this.started(next)).catch(() => undefined);
    this.fadingOut = outgoing;
    this.updateMediaSession();

    const outgoingGain = this.gain;
    this.gain = plan.incomingGain;
    const startedAt = performance.now();
    let lastJump = 0;
    clearInterval(this.fadeTimer);
    this.fadeTimer = setInterval(() => {
      const elapsed = performance.now() - startedAt;
      const t = Math.min(elapsed / (plan.duration * 1000), 1);
      const volume = playerState.get().volume;
      const [inVolume, outVolume] = mixVolumes(t);
      incoming.volume = volume * plan.incomingGain * inVolume;
      outgoing.volume = volume * outgoingGain * outVolume;
      if (plan.beatMatched) {
        // Échange des basses (lecteur de YouTube Music) : jamais deux lignes de basse en même temps.
        const [inBass, outBass] = bassSwap(t);
        if (incoming instanceof WebDeck) incoming.setBass(inBass);
        if (outgoing instanceof WebDeck) outgoing.setBass(outBass);
        // Calage des temps : le titre entrant suit le sortant par de légères corrections de vitesse.
        if (t < 0.85 && !incoming.paused && !outgoing.paused && elapsed > 400) {
          const target = plan.incomingOffset + (outgoing.currentTime - plan.start) * plan.incomingRate;
          const error = incoming.currentTime - target;
          if (Math.abs(error) > 0.3 && performance.now() - lastJump > 1500) {
            lastJump = performance.now();
            incoming.currentTime = target;
          } else {
            incoming.playbackRate = plan.incomingRate * (1 - Math.max(-0.04, Math.min(0.04, error * 0.8)));
          }
        } else if (t >= 0.85) {
          incoming.playbackRate = plan.incomingRate;
        }
      }
      if (t >= 1) {
        this.finishFade();
        if (incoming.playbackRate !== 1) this.restoreTempo(incoming, incoming.playbackRate);
      }
    }, 50);
  }

  /** Retour progressif au tempo d'origine (4 s, hauteur inchangée). */
  private restoreTempo(deck: Deck, from: number) {
    clearInterval(this.tempoTimer);
    let step = 0;
    this.tempoTimer = setInterval(() => {
      step++;
      if (deck !== this.deck || step > 40) { clearInterval(this.tempoTimer); return; }
      if (!deck.paused) deck.playbackRate = from + ((1 - from) * step) / 40;
    }, 100);
  }

  // MARK: Reprise automatique

  private recover(reason: string) {
    const track = currentTrack();
    if (!track || this.endHandled) return;
    // Lecture directe refusée par YouTube (contrôle anti-robot) : bascule sur le lecteur officiel.
    if (playerState.get().mode === 'direct' && library.get().settings.engine !== 'direct' && !this.checkingRefusal) {
      this.checkingRefusal = true;
      void api.streamError(track.id).then((detail) => {
        this.checkingRefusal = false;
        if (detail && /robot|bot|refus|sign in|connect|login|403|unavailable/i.test(detail) && currentTrack()?.id === track.id) {
          this.setMode('web');
        } else {
          this.retry(track, reason);
        }
      });
      return;
    }
    this.retry(track, reason);
  }

  private checkingRefusal = false;

  private retry(track: Track, reason: string) {
    if (this.recoveryFor !== track.id) {
      this.recoveryFor = track.id;
      this.recoveries = 0;
    }
    if (++this.recoveries > 3) {
      this.recoveries = 0;
      set({ error: `« ${track.title} » ne peut pas être lu (${reason}).`, loading: false, playing: false });
      // Raison donnée par YouTube (contrôle anti-robot…), avec la solution.
      void api.streamError(track.id).then((detail) => {
        if (!detail || currentTrack()?.id !== track.id) return;
        const robot = /robot|bot|sign in|connect/i.test(detail);
        set({ error: robot
          ? 'YouTube demande de confirmer que tu n’es pas un robot : connecte-toi à ton compte YouTube dans Réglages, puis relance le titre.'
          : `« ${track.title} » : ${detail.replace(/^Error: /, '')}` });
      });
      if (playerState.get().index + 1 < playerState.get().queue.length) this.next(false);
      return;
    }
    const position = this.deck.currentTime || timeState.get().time;
    // Après un premier échec, on force un lien neuf (le processus principal en redemande un).
    const delay = this.recoveries > 1 ? 3000 : 300;
    if (this.recoveries > 1) void api.invalidate(track.id);
    setTimeout(() => {
      if (currentTrack()?.id === track.id) this.load(position);
    }, delay);
  }

  // MARK: Commandes multimédias de Windows (touches du clavier, panneau du volume)

  private setupMediaSession() {
    const session = navigator.mediaSession;
    if (!session) return;
    session.setActionHandler('play', () => this.resume());
    session.setActionHandler('pause', () => this.pause());
    session.setActionHandler('nexttrack', () => this.next());
    session.setActionHandler('previoustrack', () => this.previous());
    session.setActionHandler('seekto', (details) => details.seekTime != null && this.seek(details.seekTime));
  }

  private updateMediaSession() {
    const track = currentTrack();
    if (!track || !navigator.mediaSession) return;
    const art = track.artwork?.replace(/=w\d+-h\d+/, '=w512-h512');
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title, artist: track.artist, album: track.album ?? '',
      artwork: art ? [{ src: art, sizes: '512x512' }] : [],
    });
  }

  // MARK: Session

  private saveSession() {
    const { queue, index } = playerState.get();
    const { time } = timeState.get();
    if (!queue.length) return;
    localStorage.setItem('session', JSON.stringify({ queue: queue.slice(Math.max(0, index - 50), index + 200), id: queue[index]?.id, time }));
  }

  private restoreSession() {
    try {
      const saved = JSON.parse(localStorage.getItem('session') ?? 'null');
      if (!saved?.queue?.length) return;
      const index = Math.max(0, saved.queue.findIndex((t: Track) => t.id === saved.id));
      set({ queue: saved.queue, index });
      setTime({ time: saved.time ?? 0 });
    } catch {
      // Session illisible : on repart de zéro.
    }
  }
}

export const player = new Engine();
// Accès pour les tests automatiques.
(window as unknown as { novaPlayer: Engine }).novaPlayer = player;

on('media:key', (action: string) => {
  if (action === 'toggle') player.toggle();
  if (action === 'next') player.next();
  if (action === 'previous') player.previous();
});
on('webplayer:consent', (visible: boolean) => {
  if (visible) notify('YouTube demande ton choix pour les cookies : réponds dans la fenêtre YouTube, la musique démarre ensuite.');
});
