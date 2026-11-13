import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BaseWindow, session, shell, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import {
  octaveAudioDefaults, octaveCatalogId, octaveHandoff, octaveId, octaveOrigin, octaveQueueQueries, octaveTrackUrl,
  type OctaveCommand, type OctavePlayback, type OctaveStart,
} from '../shared/octave.js';
import type { OctaveAudioSettings, Track } from '../shared/types.js';
import { findRecording } from './octave.js';
import { sameRecordingCredits } from './matcher.js';

const navigationOrigins = new Set([octaveOrigin, 'https://api.octavestreaming.com', 'https://discord.com']);
const interval = 250;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Sample = {
  id?: string; title: string; artist: string; album?: string; artwork?: string; position?: number; duration: number; playing: boolean;
  blocked?: 'sign-in' | 'interaction';
  targetRow?: boolean;
  ended?: boolean;
  upcoming?: Track[];
  mixing?: boolean;
  fading?: boolean;
  outgoingPosition?: number;
  audioId?: number;
  buffering?: boolean;
};
type OctaveMedia = { read(): Pick<Sample, 'position' | 'duration' | 'ended' | 'playing' | 'fading' | 'outgoingPosition' | 'audioId' | 'buffering'> | undefined; seek(seconds: number): boolean };
type Playback = {
  request: number; track: Track; source: Track; position: number; duration: number; heard: number; recorded: boolean; playing: boolean;
  stoppedAt?: number;
  audioId?: number;
  handoffAt?: number;
  seekUntil?: number;
  queueVersion?: number;
  next?: { track: Track; source: Track };
};

// Ces fonctions s'exécutent dans le lecteur Octave, sans accès aux API de Nova.
function readPlayback(targetId?: string): Sample {
  const player = navigator.mediaSession;
  const metadata = player?.metadata;
  const nowPlaying = document.querySelector('[data-np-zoom-host="true"]');
  const media = (window as Window & { __novaOctaveMedia?: OctaveMedia }).__novaOctaveMedia?.read();
  const position = [...document.querySelectorAll<HTMLInputElement>('input[aria-label="Seek"]')]
    .find((slider) => slider.getClientRects().length && Number(slider.max) > 0);
  const gate = document.querySelector('[aria-label="Link Discord to unlock Octave"]');
  const notice = document.querySelector('[aria-label="Welcome to Octave"], #owner-note-title');
  const queueOpen = Boolean(document.querySelector('button[aria-label="Save queue as playlist"]'));
  if (!queueOpen && player?.playbackState === 'playing') {
    [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Queue"]')].find(button => !button.closest('main'))?.click();
  }
  const upcoming: Track[] = queueOpen ? [...document.querySelectorAll<HTMLElement>('[data-track-id]')]
    .filter(row => row.querySelector('button[aria-label="Remove from queue"]') && / · Autoplay/.test(row.textContent ?? ''))
    .slice(0, 30).flatMap(row => {
      const title = row.querySelector('button > div > p:first-child > span.truncate')?.textContent?.trim();
      const artist = row.querySelector('button > div > p:nth-child(2)')?.cloneNode(true) as HTMLElement | undefined;
      artist?.querySelectorAll('span').forEach(node => node.remove());
      const id = row.dataset.trackId;
      return title && artist?.textContent?.trim() && id && /^\d{1,20}$/.test(id)
        ? [{id:'octave:'+id,title,artist:artist.textContent.trim(),artwork:row.querySelector('img')?.src,square:true}] : [];
    }) : [];
  return {
    id: document.querySelector<HTMLElement>('[data-track-id][data-active="true"]')?.dataset.trackId,
    title: nowPlaying?.querySelector('[data-marquee-copy="true"]')?.textContent?.trim() || metadata?.title || '',
    artist: nowPlaying?.querySelector('p')?.textContent?.trim() || metadata?.artist || '',
    album: metadata?.album || undefined, artwork: metadata?.artwork.find((item) => item.src.startsWith('https://'))?.src,
    position: media?.position ?? (position ? Number(position.value) : undefined),
    duration: media?.duration ?? Number(position?.max ?? 0),
    playing: media ? media.playing : player?.playbackState === 'playing',
    ended: media?.ended,
    blocked: gate?.getClientRects().length ? 'sign-in' : notice?.getClientRects().length ? 'interaction' : undefined,
    targetRow: targetId ? Boolean(document.querySelector(`main [data-track-id="${targetId}"]`)) : undefined,
    upcoming,
    mixing: media?.fading ?? false,
    fading: media?.fading,
    outgoingPosition: media?.outgoingPosition,
    audioId: media?.audioId,
    buffering: media?.buffering,
  };
}

function selectTrack(id: string, singleClick: boolean): boolean {
  const row = document.querySelector<HTMLElement>(`main [data-track-id="${id}"]`);
  const title = row?.querySelector<HTMLElement>('[data-cell="title"]') ?? row;
  if (!title?.getClientRects().length) return false;
  if (singleClick) title.click();
  else title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
  return true;
}

function playNextInOctave(id: string): boolean {
  const button = document.querySelector<HTMLButtonElement>(`main [data-track-id="${id}"] button[aria-label="Play next"]`);
  if (!button || button.disabled) return false;
  button.click();
  return true;
}

function clearOctaveQueue(): boolean {
  const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
    .find(element => element.textContent?.includes('Are you sure you want to clear your queue?'));
  if (dialog) {
    const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Clear Queue');
    confirm?.click();
    return Boolean(confirm);
  }
  const clear = document.querySelector<HTMLButtonElement>('button[aria-label="Clear queue"]');
  if (clear && !clear.disabled) {
    clear.click();
    return false;
  }
  if (document.querySelector('button[aria-label="Save queue as playlist"]')) return true;
  [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Queue"]')].find(button => !button.closest('main'))?.click();
  return false;
}

function searchInOctave(query: string): boolean {
  if (location.pathname !== '/search') return false;
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Artists, Songs, Lyrics, and More"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!input || !setter) return false;
  setter.call(input, query);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

async function applyAudioSettings(settings: OctaveAudioSettings): Promise<boolean> {
  if (location.pathname !== '/settings') return false;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('main button')];
  const quality = { low: 'Low', high: 'High', lossless: 'Lossless' }[settings.quality];
  const transition = { off: 'Off', crossfade: 'Crossfade', automix: 'AutoMix' }[settings.transition];
  const qualityButton = buttons.find((button) => button.textContent?.trim() === quality);
  const transitionGroup = buttons.find(button => button.textContent?.trim() === 'AutoMix')?.parentElement;
  const transitionButton = [...transitionGroup?.querySelectorAll('button') ?? []].find(button => button.textContent?.trim() === transition);
  const toggles = [
    ['Autoplay', settings.autoplay], ['Gapless Playback', settings.gapless],
    ['Sound Check', settings.soundCheck], ['Smart Shuffle', settings.smartShuffle],
  ] as const;
  if (!qualityButton || !transitionButton || !buttons.some((button) => button.getAttribute('aria-label') === 'Autoplay')) return false;
  qualityButton.click();
  transitionButton.click();
  for (const [label, desired] of toggles) {
    const button = buttons.find((candidate) => candidate.getAttribute('aria-label') === label);
    if (button && button.getAttribute('aria-checked') !== String(desired)) button.click();
  }
  // Laisser la page appliquer les clics avant de quitter les réglages.
  await new Promise(resolve => setTimeout(resolve, 120));
  if (settings.transition === 'automix') {
    const style = {automatic:'Automatic',apple:'Apple',legacy:'Octave'}[settings.automixStyle ?? 'apple'];
    const options = [...document.querySelectorAll<HTMLButtonElement>('main button')];
    const group = options.find(button => button.textContent?.trim() === 'Apple')?.parentElement;
    const button = [...group?.querySelectorAll('button') ?? []].find(button => button.textContent?.trim() === style);
    if (!button) return false;
    button.click();
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  return location.pathname === '/settings' && toggles.every(([label, desired]) => {
    const button = document.querySelector(`main button[aria-label="${label}"]`);
    return !button || button.getAttribute('aria-checked') === String(desired);
  });
}

async function openSettingsInOctave(): Promise<boolean> {
  const origin = location.href;
  const link = () => document.querySelector<HTMLAnchorElement>('a[href="/settings"]');
  if (!link()) document.querySelector<HTMLButtonElement>('button[aria-label="Account"]')?.click();
  for (let i = 0; i < 8 && location.href === origin; i++) {
    const settings = link();
    if (settings) { settings.click(); return true; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  return false;
}

function controlPlayer(command: OctaveCommand): boolean {
  if (command.type === 'next') {
    const next = document.querySelector<HTMLButtonElement>('button[aria-label="Next"]');
    if (!next || next.disabled) return false;
    next.click();
    return true;
  }
  if (command.type === 'play' || command.type === 'pause') {
    const playing = navigator.mediaSession?.playbackState === 'playing';
    if (playing === (command.type === 'play')) return true;
    const label = command.type === 'play' ? 'Play' : 'Pause';
    const button = [...document.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)]
      .find((element) => !element.closest('main'));
    button?.click();
    return Boolean(button);
  }
  if (command.type === 'seek' && (window as Window & { __novaOctaveMedia?: OctaveMedia }).__novaOctaveMedia?.seek(command.value)) return true;
  const label = command.type === 'seek' ? 'Seek' : 'Volume';
  const slider = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!slider || !setter || !Number.isFinite(command.value)) return false;
  if (command.type === 'seek') slider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  setter.call(slider, String(command.value));
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  if (command.type === 'seek') slider.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return true;
}

export class OctavePlayer {
  private view?: WebContentsView;
  private owner?: BrowserWindow;
  private background?: BaseWindow;
  private panelVisible = false;
  private timer?: ReturnType<typeof setInterval>;
  private operation = 0;
  private playback?: Playback;
  private observing = false;
  private audioSettings = octaveAudioDefaults;
  private appliedAudio?: string;
  private preparing?: Promise<Sample['blocked']>;
  private updatingAudio = false;

  constructor(
    private readonly parent: () => BrowserWindow | null,
    private readonly record: (track: Track, playedAt: number) => void,
    private readonly status: (state: OctavePlayback) => void,
    private readonly panel: (visible: boolean) => void,
    private readonly connected: () => void,
  ) {}

  setAudioSettings(settings?: OctaveAudioSettings): void {
    this.audioSettings = { ...octaveAudioDefaults, ...settings };
    const contents = this.view?.webContents;
    const playback = this.playback;
    if (contents && playback && !this.panelVisible && !this.updatingAudio && this.appliedAudio !== JSON.stringify(this.audioSettings)) {
      void this.updateAudioDuringPlayback(contents, playback).catch(() => undefined);
    }
  }

  private async updateAudioDuringPlayback(contents: WebContents, playback: Playback): Promise<void> {
    this.updatingAudio = true;
    let opened = false;
    let updated = false;
    try {
      if (new URL(contents.getURL()).pathname !== '/settings') {
        opened = await contents.executeJavaScript(`(${openSettingsInOctave.toString()})()`);
        if (!opened) return;
      }
      for (let i = 0; i < 20 && this.playback === playback && !this.panelVisible && !contents.isDestroyed(); i++) {
        const settings = JSON.stringify(this.audioSettings);
        const applied = await contents.executeJavaScript(`(${applyAudioSettings.toString()})(${settings})`);
        if (applied) {
          updated = true;
          this.appliedAudio = settings;
          if (settings === JSON.stringify(this.audioSettings)) return;
        }
        await wait(100);
      }
    } finally {
      if (opened && this.playback === playback && !this.panelVisible && !contents.isDestroyed()) {
        await contents.executeJavaScript("if (location.pathname === '/settings') history.back()").catch(() => undefined);
      }
      this.updatingAudio = false;
      if (updated && this.playback === playback && this.appliedAudio !== JSON.stringify(this.audioSettings)) {
        this.setAudioSettings(this.audioSettings);
      }
    }
  }

  private resize = () => {
    if (!this.owner || this.owner.isDestroyed()) return;
    const [width, height] = this.owner.getContentSize();
    if (this.panelVisible) this.view?.setBounds({ x: 0, y: 42, width, height: Math.max(0, height - 42) });
    else this.view?.setBounds({ x: 0, y: 0, width: 1280, height: 778 });
  };

  private contents(): WebContents {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view.webContents;
    const owner = this.parent();
    if (!owner || owner.isDestroyed()) throw new Error('Fenêtre Nova indisponible.');
    const isolated = session.fromPartition('persist:nova-octave');
    isolated.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
    isolated.setPermissionCheckHandler(() => false);
    const view = new WebContentsView({
      webPreferences: {
        session: isolated, sandbox: true, contextIsolation: true, backgroundThrottling: false,
        preload: fileURLToPath(new URL('../preload/octavePreload.cjs', import.meta.url)),
      },
    });
    this.view = view;
    this.owner = owner;
    // Une fenêtre de fond conserve les commandes de bureau d’Octave hors de l’interface de Nova.
    this.background = new BaseWindow({ show: false, width: 1280, height: 800 });
    this.background.contentView.addChildView(view);
    owner.on('resize', this.resize);
    this.resize();
    const contents = view.webContents;
    contents.setAudioMuted(true);
    const restrict = (event: Electron.Event, url: string) => {
      if (!navigationOrigins.has(new URL(url).origin)) event.preventDefault();
    };
    contents.on('will-navigate', restrict);
    contents.on('will-redirect', restrict);
    contents.on('did-navigate', (_event, address) => {
      const url = new URL(address);
      if (url.origin === octaveOrigin && url.searchParams.get('discord') === 'ok') {
        void wait(900).then(() => {
          if (!contents.isDestroyed()) this.connected();
        });
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      const destination = new URL(url);
      if (destination.protocol === 'https:') void shell.openExternal(destination.href).catch(() => undefined);
      return { action: 'deny' };
    });
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && this.panelVisible) {
        event.preventDefault();
        this.hide();
      }
    });
    contents.on('destroyed', () => {
      clearInterval(this.timer);
      if (!owner.isDestroyed()) owner.off('resize', this.resize);
      if (this.background && !this.background.isDestroyed()) this.background.destroy();
      this.background = undefined;
      if (this.panelVisible) this.panel(false);
      this.panelVisible = false;
      this.view = undefined;
      this.owner = undefined;
      this.playback = undefined;
      this.appliedAudio = undefined;
      this.operation++;
    });
    this.timer = setInterval(() => void this.observe(contents), interval);
    return contents;
  }

  private setPanel(visible: boolean): void {
    const { owner, view, background } = this;
    if (!owner || owner.isDestroyed() || !view || !background || background.isDestroyed() || this.panelVisible === visible) return;
    const from = visible ? background : owner;
    const to = visible ? owner : background;
    this.panelVisible = visible;
    from.contentView.removeChildView(view);
    to.contentView.addChildView(view);
    this.resize();
    this.panel(visible);
    (visible ? view.webContents : owner.webContents).focus();
  }

  hide(): void {
    this.setPanel(false);
  }

  async open(value?: string): Promise<void> {
    const url = new URL(value ?? '/settings', octaveOrigin);
    if (url.origin !== octaveOrigin || url.username || url.password) throw new Error('Lien Octave invalide.');
    this.stop();
    const contents = this.contents();
    this.setPanel(true);
    if (contents.getURL() !== url.href) await contents.loadURL(url.href);
  }

  warmUp(): void {
    if (this.view) return;
    void this.prepare(this.contents()).catch(() => undefined);
  }

  private prepare(contents: WebContents): Promise<Sample['blocked']> {
    const settings = JSON.stringify(this.audioSettings);
    if (this.appliedAudio === settings) return Promise.resolve(undefined);
    if (this.preparing) return this.preparing;
    const prepare = async () => {
      const address = `${octaveOrigin}/settings`;
      if (contents.getURL() !== address) await contents.loadURL(address);
      const deadline = Date.now() + 4500;
      while (!contents.isDestroyed() && contents.getURL() === address && Date.now() < deadline) {
        const sample = await this.read(contents);
        if (sample?.blocked) return sample.blocked;
        const ready = await contents.executeJavaScript(`(${applyAudioSettings.toString()})(${settings})`).catch(() => false);
        if (ready) {
          this.appliedAudio = settings;
          return;
        }
        await wait(180);
      }
    };
    this.preparing = prepare().finally(() => { this.preparing = undefined; });
    return this.preparing;
  }

  async play(track: Track, request: number, volume: number, position: number, excluding?: string): Promise<OctaveStart> {
    const previous = this.playback;
    const paused = this.stop();
    const operation = this.operation;
    this.hide();
    const selected = await findRecording(track, excluding);
    if (this.operation !== operation) return 'cancelled';
    const id = selected && octaveCatalogId(selected.id);
    if (!selected || !id) return excluding ? 'unavailable' : 'not-found';
    const contents = this.contents();
    const url = new URL(octaveTrackUrl(selected));
    let sample: Sample | undefined;
    try {
      const blocked = await this.prepare(contents);
      if (operation !== this.operation || contents.isDestroyed()) return 'cancelled';
      if (blocked) {
        this.setPanel(true);
        return blocked;
      }
      const current = await this.read(contents, id);
      if (operation !== this.operation || contents.isDestroyed()) return 'cancelled';
      const alreadyLoaded = previous?.source.id === selected.id && current && this.matches(selected, current);
      if (current?.targetRow || alreadyLoaded) {
        await paused;
        if (operation !== this.operation || contents.isDestroyed()) return 'cancelled';
        if (alreadyLoaded) {
          await this.runControl(contents, { type: 'seek', value: position });
          if (operation !== this.operation || contents.isDestroyed()) return 'cancelled';
          await this.runControl(contents, { type: 'play' });
        }
        sample = await this.startTrack(contents, operation, id, selected, 750);
      }
      if (operation !== this.operation || contents.isDestroyed()) return 'cancelled';
      if (!sample && contents.getURL() !== url.href) await contents.loadURL(url.href);
    } catch (error) {
      if (operation !== this.operation) return 'cancelled';
      throw error;
    }
    sample ??= await this.startTrack(contents, operation, id, selected);
    if (!sample && operation === this.operation && !contents.isDestroyed()) {
      const search = new URL('/search', octaveOrigin);
      search.searchParams.set('q', `${selected.title} ${selected.artist}`);
      try {
        await contents.loadURL(search.href);
      } catch (error) {
        if (operation !== this.operation) return 'cancelled';
        throw error;
      }
      sample = await this.startTrack(contents, operation, id, selected);
    }
    if (operation !== this.operation || contents.isDestroyed()) return 'cancelled';
    if (sample?.blocked) {
      this.setPanel(true);
      return sample.blocked;
    }
    if (!sample || sample.position === undefined) {
      this.stop();
      if (!excluding) return this.play(track, request, volume, position, selected.id);
      return 'unavailable';
    }
    await this.runControl(contents, { type: 'volume', value: volume });
    if (position > 0 || sample.position >= 2) await this.runControl(contents, { type: 'seek', value: position });
    if (operation !== this.operation || contents.isDestroyed()) return 'cancelled';
    this.playback = {
      request, track, source: selected, position: sample.position, duration: sample.duration || selected.duration || 0,
      heard: 0, recorded: false, playing: true, audioId: sample.audioId,
    };
    contents.setAudioMuted(false);
    return 'playing';
  }

  private async startTrack(contents: WebContents, operation: number, id: string, track: Track, timeout = 9000): Promise<Sample | undefined> {
    const start = Date.now();
    let sentAt = 0;
    let retried = false;
    while (operation === this.operation && !contents.isDestroyed() && Date.now() - start < timeout) {
      const sample = await this.read(contents, id);
      if (operation !== this.operation) break;
      if (sample?.blocked) return sample;
      const matches = sample && this.matches(track, sample);
      if (matches && sample.playing && sample.position !== undefined) return sample;
      if (matches && !sample.playing && sentAt && Date.now() - sentAt >= 900) {
        await this.runControl(contents, { type: 'play' });
      }
      if ((!matches || !sample.targetRow) && Date.now() - start >= 4500) return;
      if (!sentAt || (!retried && !matches && Date.now() - sentAt >= 1800)) {
        const sent = await contents.executeJavaScript(`(${selectTrack.toString()})(${JSON.stringify(id)}, ${Boolean(sentAt)})`, true).catch(() => false);
        if (sent) {
          retried = Boolean(sentAt);
          sentAt = Date.now();
        }
      }
      await wait(180);
    }
  }

  async command(request: number, command: OctaveCommand): Promise<boolean> {
    const contents = this.view?.webContents;
    if (this.playback?.request !== request || !contents || contents.isDestroyed()) return false;
    if (command.type === 'pause' || command.type === 'seek') {
      this.playback.stoppedAt = undefined;
      this.playback.handoffAt = undefined;
      if (command.type === 'seek') {
        this.playback.position = command.value;
        this.playback.seekUntil = Date.now() + 1000;
      }
    }
    return this.runControl(contents, command);
  }

  async queueNext(request: number, track?: Track, reset = false): Promise<string | undefined> {
    const playback = this.playback;
    const contents = this.view?.webContents;
    if (playback?.request !== request || !contents) return;
    const version = (playback.queueVersion ?? 0) + 1;
    playback.queueVersion = version;
    const ready = () => this.playback === playback && playback.queueVersion === version && !this.panelVisible && !contents.isDestroyed()
      && contents.getURL().startsWith(`${octaveOrigin}/`);
    const enqueue = () => contents.executeJavaScript(`(${playNextInOctave.toString()})(${JSON.stringify(id)})`, true).catch(() => false);
    if (reset) {
      playback.next = undefined;
      for (let i = 0; i < 10 && ready(); i++) {
        if (await contents.executeJavaScript('(' + clearOctaveQueue.toString() + ')()').catch(() => false)) break;
        await wait(100);
      }
    }
    if (!track || !ready()) return;
    const source = await findRecording(track);
    const id = source && octaveCatalogId(source.id);
    if (!source || !id || source.id === playback.source.id || !ready()) return;
    const queued = () => {
      playback.next = { track, source };
      return source.id;
    };
    if (await enqueue()) return ready() ? queued() : undefined;
    if (!ready()) return;
    if (new URL(contents.getURL()).pathname !== '/search') {
      await contents.executeJavaScript('document.querySelector(\'a[href="/search"]\')?.click()', true).catch(() => undefined);
    }
    const queries = octaveQueueQueries(source);
    let submitted = false;
    for (let attempt = 0; attempt < queries.length * 8 && ready(); attempt++) {
      if (attempt % 8 === 0) submitted = false;
      if (await enqueue()) return ready() ? queued() : undefined;
      if (!submitted && ready()) {
        submitted = await contents.executeJavaScript(`(${searchInOctave.toString()})(${JSON.stringify(queries[Math.floor(attempt / 8)])})`, true).catch(() => false);
      }
      await wait(350);
    }
  }

  stop(): Promise<boolean> {
    this.operation++;
    this.playback = undefined;
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return Promise.resolve(false);
    contents.setAudioMuted(true);
    return this.runControl(contents, { type: 'pause' });
  }

  destroy(): void {
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
  }

  private runControl(contents: WebContents, command: OctaveCommand): Promise<boolean> {
    if (contents.isDestroyed() || !contents.getURL().startsWith(`${octaveOrigin}/`)) return Promise.resolve(false);
    return contents.executeJavaScript(`(${controlPlayer.toString()})(${JSON.stringify(command)})`, true).catch(() => false);
  }

  private read(contents: WebContents, targetId?: string): Promise<Sample | undefined> {
    if (contents.isDestroyed() || !contents.getURL().startsWith(`${octaveOrigin}/`)) return Promise.resolve(undefined);
    return contents.executeJavaScript(`(${readPlayback.toString()})(${JSON.stringify(targetId)})`).catch(() => undefined);
  }

  private matches(track: Track, sample: Sample): boolean {
    const id = octaveCatalogId(track.id);
    if (!sample.title) return !!id && sample.id === id;
    return sameRecordingCredits(track, {id:'sample',title:sample.title,artist:sample.artist});
  }

  private async observe(contents: WebContents): Promise<void> {
    const playback = this.playback;
    if (!playback || this.observing) return;
    this.observing = true;
    try {
      const sample = await this.read(contents);
      if (this.playback !== playback || contents.isDestroyed() || !sample) return;
      if (sample.blocked === 'sign-in') {
        this.stop();
        this.setPanel(true);
        this.status({ request: playback.request, time: playback.position, duration: playback.duration, playing: false, signIn: true });
        return;
      }
      if (sample.position === undefined) return;
      if (sample.fading) {
        // Octave peut publier les métadonnées du titre entrant avant la fin du fondu.
        // Attendre la fin de sa transition avant de déplacer la file Nova.
        if (sample.outgoingPosition != null && sample.outgoingPosition >= playback.position) playback.position = sample.outgoingPosition;
        this.status({request:playback.request,time:playback.position,duration:playback.duration,
          playing:sample.playing, mixing:sample.mixing, upcoming:sample.upcoming});
        return;
      }
      const delta = sample.position - playback.position;
      let next: Track | undefined;
      let queuedTrackId: string | undefined;
      const planned = playback.next;
      const currentMatches = this.matches(playback.source, sample);
      const plannedMatches = !!planned && this.matches(planned.source, sample);
      const now = Date.now();
      if (sample.playing && now >= (playback.seekUntil ?? 0) && octaveHandoff(playback, { ...sample, position: sample.position })) {
        playback.handoffAt = now;
      }
      if (playback.handoffAt != null && now - playback.handoffAt > 3500) playback.handoffAt = undefined;
      const switched = playback.handoffAt != null;
      if (sample.playing && switched && (plannedMatches || (sample.title && !currentMatches))) {
        playback.next = undefined;
        playback.handoffAt = undefined;
        playback.queueVersion = (playback.queueVersion ?? 0) + 1;
        const key = JSON.stringify([sample.title, sample.artist, sample.album]);
        next = planned && plannedMatches ? planned.source : {
          id: octaveId(sample.id) ?? `octave:played-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
          title: sample.title, artist: sample.artist, album: sample.album, artwork: sample.artwork,
          duration: sample.duration || undefined, square: true,
        };
        playback.track = next === planned?.source ? planned.track : next;
        if (next === planned?.source) queuedTrackId = planned.track.id;
        playback.source = next;
        playback.heard = 0;
        playback.recorded = false;
      }
      playback.audioId = sample.audioId ?? playback.audioId;
      if (!sample.playing && !playback.stoppedAt
        && (sample.ended || (playback.playing && playback.duration > 0 && playback.duration - playback.position < 1.5))) {
        playback.stoppedAt = Date.now();
      }
      if (sample.playing || sample.buffering) playback.stoppedAt = undefined;
      if (playback.stoppedAt && Date.now() - playback.stoppedAt >= 10_000) {
        this.stop();
        this.status({ request: playback.request, time: playback.position, duration: playback.duration, playing: false, ended: true });
        return;
      }
      playback.playing = sample.playing;
      playback.position = sample.position;
      playback.duration = sample.duration || playback.duration;
      this.status({ request: playback.request, time: sample.position, duration: playback.duration, playing: sample.playing, track: next, queuedTrackId,
        upcoming: sample.upcoming, mixing: sample.mixing });
      if (!next && playback.handoffAt == null && !playback.recorded && sample.playing && contents.isCurrentlyAudible() && delta > 0 && delta < 2) {
        playback.heard += delta;
        if (playback.heard >= 5) {
          playback.recorded = true;
          this.record({ ...playback.track, artwork: playback.track.artwork ?? playback.source.artwork }, Date.now());
        }
      }
    } finally {
      this.observing = false;
    }
  }
}
