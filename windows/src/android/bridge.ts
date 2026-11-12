// Nova pour Android : ce que fait le processus principal sur PC (YouTube Music, disque, compte,
// import, lecteur), dans l'app Android. L'interface appelle les mêmes canaux que sur Windows.
import { Capacitor, CapacitorHttp, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Platform } from 'youtubei.js';
import type { ImportedPlaylist, ImportProgress, LibraryState, Track } from '../shared/types';
import { defaultSettings } from '../shared/types';
import { searchConcerts } from '../main/concerts';
import * as importer from '../main/importer';
import { runImport as runImports } from '../main/importRun';
import { lyrics } from '../main/lyrics';
import { loadMatches, match, savedMatches } from '../main/matcher';
import * as yt from '../main/yt';
import * as octave from '../main/octave';
import { syncOctaveListen, findYouTubeRecording } from '../main/octaveHistory';
import { isOctaveId } from '../shared/octave';
import { AndroidOctavePlayer } from './octavePlayer';

interface NovaPlayer {
  load(options: { deck: number; videoId: string; startAt: number; volume: number }): Promise<void>;
  command(options: { deck: number; command: { type: string; value?: number } }): Promise<void>;
  setMediaInfo(options: { title: string; artist: string; artwork?: string; playing: boolean }): Promise<void>;
  showDeck(options: { deck: number }): Promise<void>;
  login(): Promise<{ cookie?: string }>;
  logout(): Promise<void>;
  openPage(options: { url: string }): Promise<void>;
  openExternal(options: { url: string }): Promise<void>;
  isTV(): Promise<{ tv: boolean }>;
  syncInfo(): Promise<{ pcId: string; token: string; port: number; address: string; name: string; paired: boolean; phoneName?: string; lastSync?: number }>;
  exchangeHistory(options: { host: string; port: number; token: string; history: string }): Promise<{ history: string }>;
  unpair(): Promise<void>;
  setRemoteState(options: { state: string }): Promise<void>;
  jamHost(options: { name: string }): Promise<{ port: number; addresses: string[] }>;
  jamBroadcast(options: { message: string }): Promise<void>;
  jamBrowse(): Promise<void>;
  jamStopBrowsing(): Promise<void>;
  jamJoin(options: { address: string; port: number; name: string }): Promise<void>;
  jamToHost(options: { message: string }): Promise<void>;
  jamStop(): Promise<void>;
  startTicker(options: { interval: number }): Promise<void>;
  stopTicker(): Promise<void>;
  octaveNavigate(options: { url: string }): Promise<void>;
  octaveCall(options: { operation: string; args?: object }): Promise<{ value: string }>;
  octavePanel(options: { visible: boolean }): Promise<void>;
  addListener(event: 'octaveConnected', listener: () => void): Promise<PluginListenerHandle>;
  addListener(event: 'tick', listener: () => void): Promise<PluginListenerHandle>;
  addListener(event: 'relay', listener: (data: { channel: string; args: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'event', listener: (data: { deck: number; payload: unknown }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'media', listener: (data: { action: string; seconds?: number }) => void): Promise<PluginListenerHandle>;
}

const native = registerPlugin<NovaPlayer>('NovaPlayer');
const listeners = new Map<string, Set<(...args: any[]) => void>>();
const emit = (channel: string, ...args: unknown[]) => listeners.get(channel)?.forEach((listener) => listener(...args));
const octavePlayer = new AndroidOctavePlayer(native, (status) => emit('octave:status', status), (track) => {
  emit('octave:played', track, Date.now());
  void syncOctaveListen(track, async () => {
    const { settings } = await loadLibrary();
    return settings.recordHistory && settings.syncOctaveToYouTube !== false && Boolean(localStorage.getItem('youtubeCookie'));
  }).catch(() => emit('octave:sync-error'));
});

// MARK: Réseau (requêtes faites par Android : pas de CORS, et les en-têtes Cookie/User-Agent passent)

async function nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : undefined;
  const url = request ? request.url : String(input);
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? request?.headers).forEach((value, key) => { headers[key] = value; });
  let data: string | undefined;
  if (typeof init?.body === 'string') data = init.body;
  else if (init?.body instanceof URLSearchParams) data = init.body.toString();
  else if (request && method !== 'GET' && method !== 'HEAD') data = await request.clone().text();
  const response = await CapacitorHttp.request({ url, method, headers, data, responseType: 'text',
    connectTimeout: 12_000, readTimeout: 12_000 });
  const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  const result = new Response(response.status === 204 || response.status === 304 ? null : body, { status: response.status, headers: response.headers });
  Object.defineProperty(result, 'url', { value: response.url ?? url });
  return result;
}
if (Capacitor.isNativePlatform()) {
  Platform.shim.fetch = nativeFetch as typeof fetch;
  octave.configureOctaveCatalog(nativeFetch as typeof fetch);
}

// MARK: Disque

async function readJSON<T>(name: string, fallback: T): Promise<T> {
  try {
    const file = await Filesystem.readFile({ path: name, directory: Directory.Data, encoding: Encoding.UTF8 });
    return JSON.parse(file.data as string) as T;
  } catch {
    return fallback;
  }
}

async function writeJSON(name: string, value: unknown) {
  await Filesystem.writeFile({ path: name, data: JSON.stringify(value), directory: Directory.Data, encoding: Encoding.UTF8 });
}

const emptyLibrary: LibraryState = { recents: [], liked: [], playlists: [], saved: [], searches: [], stats: {}, settings: defaultSettings };

async function loadLibrary(): Promise<LibraryState> {
  const saved = await readJSON<Partial<LibraryState>>('library.json', {});
  return { ...emptyLibrary, ...saved, settings: { ...defaultSettings, ...(saved.settings ?? {}) } };
}

async function configure(cookie?: string | null) {
  const library = await loadLibrary();
  // Pas de lecteur YouTube à télécharger : la lecture passe par le lecteur officiel de YouTube Music.
  yt.configure({ lang: library.settings.language, location: library.settings.region, cookie: cookie ?? undefined, retrievePlayer: false });
}

// MARK: Import

let importCancelled = false;

function runImport(playlists: ImportedPlaylist[], toAccount: boolean) {
  importCancelled = false;
  return runImports(playlists, toAccount, {
    emit: (progress) => emit('import:progress', progress), cancelled: () => importCancelled,
    saveMatches: (entries) => writeJSON('matches.json', entries), width: 3,
  });
}

/** Sélecteur de fichier du téléphone. */
function pickFiles(accept: string, multiple: boolean): Promise<{ name: string; text: string }[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = async () => resolve(await Promise.all([...(input.files ?? [])].map(async (file) => ({ name: file.name, text: await file.text() }))));
    input.click();
  });
}

// MARK: Canaux

let lastMedia = '';

const handlers: Record<string, (...args: any[]) => unknown> = {
  'yt:search': (query, scope) => scope === 'video' ? yt.search(query, scope) : octave.search(query, scope),
  'yt:suggestions': (query) => octave.suggestions(query),
  'yt:home': () => octave.charts(true),
  'yt:homeMore': () => ({ shelves: [] }),
  'yt:explore': () => octave.charts(),
  'yt:browse': (link) => yt.browse(link),
  'yt:artist': (id) => isOctaveId(id) ? octave.artist(id) : yt.artist(id),
  'yt:artistSongs': (id) => isOctaveId(id) ? octave.artistSongs(id) : yt.artistAllSongs(id),
  'yt:collection': (target) => isOctaveId(target.id) ? octave.collection(target) : yt.collection(target),
  'yt:radio': (id) => isOctaveId(id) ? octave.radio(id) : yt.radio(id),
  'yt:related': (id) => isOctaveId(id) ? octave.related(id) : yt.related(id),
  'yt:squareArtwork': (id) => yt.squareArtwork(id),
  'art:track': (track) => isOctaveId(track.id) ? octave.trackArtwork(track) : yt.squareArtwork(track.id),
  'art:palette': () => null,
  'lyrics:get': (track, duration) => lyrics(track, duration),
  'stream:prefetch': () => undefined,
  'ui:ready': () => undefined,
  'stream:invalidate': () => undefined,
  'stream:error': () => undefined,

  'library:load': () => loadLibrary(),
  'library:save': (state) => writeJSON('library.json', state),
  'settings:apply': (settings) => {
    octavePlayer.setSettings(settings.octaveAudio);
    yt.configure({ lang: settings.language, location: settings.region });
  },

  'account:get': async () => {
    const cookie = localStorage.getItem('youtubeCookie');
    if (!cookie) return { signedIn: false };
    const info = await yt.accountInfo().catch(() => ({}));
    return { signedIn: true, ...info };
  },
  'account:login': async () => {
    const { cookie } = await native.login();
    if (!cookie) return false;
    localStorage.setItem('youtubeCookie', cookie);
    await configure(cookie);
    return true;
  },
  'account:logout': async () => {
    localStorage.removeItem('youtubeCookie');
    await native.logout();
    await configure(null);
  },
  'account:liked': () => yt.likedSongs(),
  'account:playlists': () => yt.accountPlaylists(),
  'account:like': (id, liked) => yt.setLike(id, liked),
  'account:createPlaylist': (name, ids, privacy) => yt.createAccountPlaylist(name, ids, privacy),
  'account:addToPlaylist': (playlistId, ids) => yt.addToAccountPlaylist(playlistId, ids),
  'youtube:open': (url) => native.openPage({ url }),

  'import:link': (link) => importer.fromLink(link),
  'import:file': async () => (await pickFiles('.csv,.tsv,.txt,.json,text/*,application/json', true))
    .flatMap((file) => importer.fromFile(file.text, file.name)),
  'import:run': (playlists, toAccount) => runImport(playlists, toAccount),
  'import:match': (wanted) => match(wanted),
  'import:cancel': () => { importCancelled = true; },
  'phone:openFile': async () => {
    const [file] = await pickFiles('.json,application/json', false);
    if (!file) return null;
    const parsed = JSON.parse(file.text);
    return parsed.library ? { ...parsed.library, shared: parsed.shared } : parsed;
  },
  // iPhone associé (QR code) : il envoie sa bibliothèque et pilote la lecture, comme avec le PC.
  'phone:pairing': async () => {
    const info = await native.syncInfo();
    const query = new URLSearchParams({ u: `http://${info.address}:${info.port}/sync`, t: info.token, n: info.name, id: info.pcId });
    return { link: `nova://sync?${query.toString()}`, address: `${info.address}:${info.port}`, paired: info.paired, phoneName: info.phoneName, lastSync: info.lastSync };
  },
  'phone:exchange-history': async (host: string, port: number, token: string, history: string) =>
    JSON.parse((await native.exchangeHistory({ host, port, token, history })).history),
  'phone:unpair': () => native.unpair(),
  'phone:network': () => ({ publicNetworks: [], allowed: true }),
  'phone:allowNetwork': () => true,

  // Jam sur le réseau local (même protocole que sur PC).
  'jam:host': (name) => native.jamHost({ name }),
  'jam:broadcast': (message) => native.jamBroadcast({ message: JSON.stringify(message) }),
  'jam:browse': () => native.jamBrowse(),
  'jam:stopBrowsing': () => native.jamStopBrowsing(),
  'jam:join': (address, port, name) => native.jamJoin({ address, port, name }),
  'jam:toHost': (message) => native.jamToHost({ message: JSON.stringify(message) }),
  'jam:stop': () => native.jamStop(),

  'concerts:search': (options) => searchConcerts(options),
  'shell:open': (url) => native.openExternal({ url }),

  // Lecteur officiel de YouTube Music (WebView invisible, côté Android).
  'webplayer:load': (deck, videoId, startAt, volume) => native.load({ deck, videoId, startAt, volume }),
  'webplayer:command': (deck, command) => native.command({ deck, command }),
  'webplayer:show': (deck) => native.showDeck({ deck }),
  'octave:open': (url) => octavePlayer.open(url),
  'octave:hide': () => octavePlayer.hide(),
  'octave:stop': () => octavePlayer.stop(),
  'octave:play': (track, request, volume, position) => octavePlayer.play(track, request, volume, position),
  'octave:command': (request, command) => octavePlayer.command(request, command),
  'octave:queue-next': (request, track) => octavePlayer.queueNext(request, track),
  'octave:youtube-match': (track) => findYouTubeRecording(track),

  // État de lecture publié chaque seconde : notification multimédia et écran verrouillé d'Android.
  'remote:state': (state) => {
    void native.setRemoteState({ state: JSON.stringify(state) }).catch(() => undefined);
    const key = `${state?.track?.id}|${state?.playing}`;
    if (!state?.track || key === lastMedia) return;
    lastMedia = key;
    void native.setMediaInfo({ title: state.track.title, artist: state.track.artist, artwork: state.track.artworkURL, playing: state.playing });
  },
};

const unsupported = (_channel: string) => () => {
  throw new Error('Indisponible sur Android.');
};

window.nova = {
  invoke: async (channel: string, ...args: unknown[]) => (handlers[channel] ?? unsupported(channel))(...args) as any,
  on: (channel: string, listener: (...args: any[]) => void) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(listener);
    return () => listeners.get(channel)?.delete(listener);
  },
};
(window.nova as any).platform = 'android';
window.nova.octave = Capacitor.isNativePlatform();

// Minuteries des transitions rythmées par Android (une page invisible voit ses minuteries ralenties).
const tickers = new Map<number, { ms: number; fn: () => void; last: number }>();
let nextTicker = 0;
let ticking = false;
if (Capacitor.isNativePlatform()) {
  native.addListener('tick', () => {
    const now = performance.now();
    for (const entry of [...tickers.values()]) {
      if (now - entry.last >= entry.ms - 4) {
        entry.last = now;
        entry.fn();
      }
    }
  }).catch(() => undefined);
  (window as any).novaTicker = {
    every(ms: number, fn: () => void) {
      const id = ++nextTicker;
      tickers.set(id, { ms, fn, last: performance.now() });
      if (!ticking) { ticking = true; void native.startTicker({ interval: 20 }).catch(() => undefined); }
      return id;
    },
    clear(id: number) {
      tickers.delete(id);
      if (!tickers.size && ticking) { ticking = false; void native.stopTicker().catch(() => undefined); }
    },
  };
}

// YouTube Music utilise son lecteur officiel sur Android.
localStorage.setItem('engineMode', 'web');

void native.addListener('event', ({ deck, payload }) => emit('webplayer:event', deck, payload)).catch(() => undefined);
native.addListener('media', ({ action, seconds }) => emit('media:key', action, seconds)).catch(() => undefined);
native.addListener('octaveConnected', () => emit('octave:connected')).catch(() => undefined);
// Messages du réseau local (iPhone, Jam) : mêmes canaux que sur PC.
native.addListener('relay', ({ channel, args }) => {
  try { emit(channel, ...JSON.parse(args)); } catch { /* message illisible */ }
}).catch(() => undefined);

export async function prepare() {
  if (!Capacitor.isNativePlatform()) return;
  loadMatches(await readJSON('matches.json', {}));
  await configure(localStorage.getItem('youtubeCookie'));
  octavePlayer.setSettings((await loadLibrary()).settings.octaveAudio);
  octavePlayer.warmUp();
  const { tv } = await native.isTV().catch(() => ({ tv: false }));
  document.documentElement.classList.add('android');
  if (tv) {
    document.documentElement.classList.add('tv');
    const { enableSpatialNavigation } = await import('./spatial');
    enableSpatialNavigation();
  }
}
