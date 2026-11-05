// Nova pour Android : ce que fait le processus principal sur PC (YouTube Music, disque, compte,
// import, lecteur), dans l'app Android. L'interface appelle les mêmes canaux que sur Windows.
import { Capacitor, CapacitorHttp, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Platform } from 'youtubei.js';
import type { ImportedPlaylist, ImportProgress, LibraryState, Track } from '../shared/types';
import { defaultSettings } from '../shared/types';
import { searchConcerts } from '../main/concerts';
import * as importer from '../main/importer';
import { lyrics } from '../main/lyrics';
import { loadMatches, match, savedMatches } from '../main/matcher';
import * as yt from '../main/yt';

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
  addListener(event: 'event', listener: (data: { deck: number; payload: unknown }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'media', listener: (data: { action: string }) => void): Promise<PluginListenerHandle>;
}

const native = registerPlugin<NovaPlayer>('NovaPlayer');
const listeners = new Map<string, Set<(...args: any[]) => void>>();
const emit = (channel: string, ...args: unknown[]) => listeners.get(channel)?.forEach((listener) => listener(...args));

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
  const response = await CapacitorHttp.request({ url, method, headers, data, responseType: 'text' });
  const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  const result = new Response(response.status === 204 || response.status === 304 ? null : body, { status: response.status, headers: response.headers });
  Object.defineProperty(result, 'url', { value: response.url ?? url });
  return result;
}
if (Capacitor.isNativePlatform()) Platform.shim.fetch = nativeFetch as typeof fetch;

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

async function runImport(playlists: ImportedPlaylist[], toAccount: boolean) {
  importCancelled = false;
  const results: { name: string; tracks: Track[]; youtubeId?: string; missing: number }[] = [];
  for (const playlist of playlists) {
    const progress: ImportProgress = { name: playlist.name, total: playlist.tracks.length, processed: 0, matched: 0, missing: [], done: false };
    const found: (Track | undefined)[] = new Array(playlist.tracks.length);
    let next = 0;
    const worker = async () => {
      while (!importCancelled && next < playlist.tracks.length) {
        const position = next++;
        const wanted = playlist.tracks[position];
        const track = wanted.youtubeId
          ? { id: wanted.youtubeId, title: wanted.title, artist: wanted.artist, album: wanted.album, duration: wanted.duration }
          : await match(wanted).catch(() => undefined);
        found[position] = track;
        progress.processed++;
        if (track) progress.matched++;
        else progress.missing.push(wanted);
        if (progress.processed % 5 === 0 || progress.processed === progress.total) emit('import:progress', { ...progress });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const seen = new Set<string>();
    const tracks = found.filter((t): t is Track => !!t && !seen.has(t.id) && !!seen.add(t.id));
    let youtubeId: string | undefined;
    if (toAccount && tracks.length && !importCancelled) {
      youtubeId = await yt.createAccountPlaylist(playlist.name, tracks.map((t) => t.id)).catch(() => undefined);
    }
    results.push({ name: playlist.name, tracks, youtubeId, missing: progress.missing.length });
    emit('import:progress', { ...progress, done: true, playlistId: youtubeId });
    await writeJSON('matches.json', savedMatches());
    if (importCancelled) break;
  }
  return results;
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
  'yt:search': (query, scope) => yt.search(query, scope),
  'yt:suggestions': (query) => yt.suggestions(query),
  'yt:home': () => yt.home(),
  'yt:homeMore': () => yt.homeMore(),
  'yt:explore': () => yt.explore(),
  'yt:browse': (link) => yt.browse(link),
  'yt:artist': (id) => yt.artist(id),
  'yt:artistSongs': (id) => yt.artistAllSongs(id),
  'yt:collection': (target) => yt.collection(target),
  'yt:radio': (id) => yt.radio(id),
  'yt:related': (id) => yt.related(id),
  'yt:squareArtwork': (id) => yt.squareArtwork(id),
  'lyrics:get': (track, duration) => lyrics(track, duration),
  'stream:prefetch': () => undefined,
  'ui:ready': () => undefined,
  'stream:invalidate': () => undefined,
  'stream:error': () => undefined,

  'library:load': () => loadLibrary(),
  'library:save': (state) => writeJSON('library.json', state),
  'settings:apply': (settings) => yt.configure({ lang: settings.language, location: settings.region }),

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
  'phone:pairing': () => { throw new Error('La synchronisation avec l’iPhone se fait sur le PC.'); },

  'concerts:search': (options) => searchConcerts(options),
  'shell:open': (url) => native.openExternal({ url }),

  // Lecteur officiel de YouTube Music (WebView invisible, côté Android).
  'webplayer:load': (deck, videoId, startAt, volume) => native.load({ deck, videoId, startAt, volume }),
  'webplayer:command': (deck, command) => native.command({ deck, command }),
  'webplayer:show': (deck) => native.showDeck({ deck }),

  // État de lecture publié chaque seconde : notification multimédia et écran verrouillé d'Android.
  'remote:state': (state) => {
    const key = `${state?.track?.id}|${state?.playing}`;
    if (!state?.track || key === lastMedia) return;
    lastMedia = key;
    void native.setMediaInfo({ title: state.track.title, artist: state.track.artist, artwork: state.track.artworkURL, playing: state.playing });
  },
};

const unsupported = (channel: string) => () => {
  throw new Error(channel.startsWith('jam:') ? 'Le Jam n’est pas encore disponible sur Android.' : 'Indisponible sur Android.');
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

// Sur Android, la lecture passe toujours par le lecteur officiel de YouTube Music.
localStorage.setItem('engineMode', 'web');

void native.addListener('event', ({ deck, payload }) => emit('webplayer:event', deck, payload)).catch(() => undefined);
native.addListener('media', ({ action }) => emit('media:key', action === 'play' || action === 'pause' ? 'toggle' : action)).catch(() => undefined);

export async function prepare() {
  if (!Capacitor.isNativePlatform()) return;
  loadMatches(await readJSON('matches.json', {}));
  await configure(localStorage.getItem('youtubeCookie'));
  const { tv } = await native.isTV().catch(() => ({ tv: false }));
  document.documentElement.classList.add('android');
  if (tv) {
    document.documentElement.classList.add('tv');
    const { enableSpatialNavigation } = await import('./spatial');
    enableSpatialNavigation();
  }
}
