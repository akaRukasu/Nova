// Nova pour Windows : processus principal.
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, session, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImportedPlaylist, ImportProgress, LibraryState, Track } from '../shared/types.js';
import { defaultSettings } from '../shared/types.js';
import { searchConcerts } from './concerts.js';
import * as importer from './importer.js';
import * as jam from './jam.js';
import { lyrics } from './lyrics.js';
import { startReceiving, stopReceiving } from './phoneSync.js';
import { loadMatches, match, savedMatches } from './matcher.js';
import { handleStreams, invalidate, prefetch, registerScheme, setQuality } from './streams.js';
import * as yt from './yt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = () => app.getPath('userData');
const file = (name: string) => path.join(dataDir(), name);

registerScheme();
// Une seule fenêtre de Nova à la fois.
if (!app.requestSingleInstanceLock()) app.quit();

let window: BrowserWindow | null = null;
const sendToUI = (channel: string, ...args: unknown[]) => window?.webContents.send(channel, ...args);
jam.setSender(sendToUI);

// MARK: - Disque

async function readJSON<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file(name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Écriture atomique (fichier temporaire puis renommage) : jamais de bibliothèque à moitié écrite. */
async function writeJSON(name: string, value: unknown) {
  await fs.mkdir(dataDir(), { recursive: true });
  const temp = file(`${name}.tmp`);
  await fs.writeFile(temp, JSON.stringify(value));
  await fs.rename(temp, file(name));
}

const emptyLibrary: LibraryState = { recents: [], liked: [], playlists: [], saved: [], searches: [], stats: {}, settings: defaultSettings };

async function loadLibrary(): Promise<LibraryState> {
  const saved = await readJSON<Partial<LibraryState>>('library.json', {});
  return { ...emptyLibrary, ...saved, settings: { ...defaultSettings, ...(saved.settings ?? {}) } };
}

// MARK: - Compte YouTube (cookies chiffrés par Windows)

async function loadCookie(): Promise<string | undefined> {
  try {
    const data = await fs.readFile(file('account.bin'));
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(data) : data.toString('utf8');
  } catch {
    return undefined;
  }
}

async function saveCookie(cookie: string | undefined) {
  if (!cookie) {
    await fs.rm(file('account.bin'), { force: true });
    return;
  }
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(cookie) : Buffer.from(cookie, 'utf8');
  await fs.writeFile(file('account.bin'), data);
}

async function configureYouTube(cookie?: string) {
  const library = await loadLibrary();
  yt.configure({
    lang: library.settings.language,
    location: library.settings.region,
    cookie,
    cacheDir: file('youtube-cache'),
  });
  setQuality(library.settings.highQuality);
}

const loginPartition = 'persist:google';
// Google refuse les connexions depuis certains navigateurs intégrés : on se présente comme Firefox.
const loginAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';

function login(): Promise<boolean> {
  return new Promise((resolve) => {
    const loginWindow = new BrowserWindow({
      width: 480, height: 720, parent: window ?? undefined, modal: true, title: 'Se connecter à YouTube',
      autoHideMenuBar: true, webPreferences: { partition: loginPartition },
    });
    loginWindow.webContents.setUserAgent(loginAgent);
    let finished = false;
    const check = async () => {
      const cookies = await session.fromPartition(loginPartition).cookies.get({ domain: '.youtube.com' });
      if (!cookies.some((c) => c.name === 'SAPISID' || c.name === '__Secure-3PAPISID')) return;
      const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      finished = true;
      await saveCookie(cookie);
      await configureYouTube(cookie);
      loginWindow.close();
      resolve(true);
    };
    loginWindow.webContents.on('did-navigate', (_event, url) => {
      if (url.startsWith('https://music.youtube.com')) void check();
    });
    loginWindow.on('closed', () => { if (!finished) resolve(false); });
    void loginWindow.loadURL('https://accounts.google.com/ServiceLogin?service=youtube&continue=' +
      encodeURIComponent('https://music.youtube.com/'));
  });
}

async function logout() {
  await saveCookie(undefined);
  await session.fromPartition(loginPartition).clearStorageData();
  await configureYouTube(undefined);
}

// MARK: - Import

let importCancelled = false;

async function runImport(playlists: ImportedPlaylist[], toAccount: boolean) {
  importCancelled = false;
  const results: { name: string; tracks: Track[]; youtubeId?: string; missing: number }[] = [];
  for (const playlist of playlists) {
    const progress: ImportProgress = { name: playlist.name, total: playlist.tracks.length, processed: 0, matched: 0, missing: [], done: false };
    const found: (Track | undefined)[] = new Array(playlist.tracks.length);
    let next = 0;
    // Quatre recherches en parallèle : rapide, sans saturer YouTube Music.
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
        if (progress.processed % 5 === 0 || progress.processed === progress.total) sendToUI('import:progress', { ...progress });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const seen = new Set<string>();
    const tracks = found.filter((t): t is Track => !!t && !seen.has(t.id) && !!seen.add(t.id));
    let youtubeId: string | undefined;
    // Compte YouTube connecté : la playlist est aussi créée sur le compte (visible sur l'iPhone).
    if (toAccount && tracks.length && !importCancelled) {
      youtubeId = await yt.createAccountPlaylist(playlist.name, tracks.map((t) => t.id)).catch(() => undefined);
    }
    results.push({ name: playlist.name, tracks, youtubeId, missing: progress.missing.length });
    sendToUI('import:progress', { ...progress, done: true, playlistId: youtubeId });
    await writeJSON('matches.json', savedMatches());
    if (importCancelled) break;
  }
  return results;
}

// MARK: - Fenêtre

async function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Nova',
    backgroundColor: dark ? '#1c1c1e' : '#f5f5f7',
    backgroundMaterial: 'mica',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#ffffff' : '#1c1c1e', height: 40 },
    icon: path.join(here, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(here, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      // La musique continue quand la fenêtre est réduite.
      backgroundThrottling: false,
    },
  });
  nativeTheme.on('updated', () => {
    window?.setTitleBarOverlay({ color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#1c1c1e', height: 40 });
  });
  // Liens externes (billetterie, aide) : dans le navigateur.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  await window.loadFile(path.join(here, '../renderer/index.html'));
}

function handle(channel: string, listener: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (_event, ...args) => listener(...args));
}

app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});

app.whenReady().then(async () => {
  app.setAppUserModelId('com.akarukasu.nova');
  handleStreams();
  loadMatches(await readJSON('matches.json', {}));
  const cookie = await loadCookie();
  await configureYouTube(cookie);

  // YouTube Music
  handle('yt:search', (query: string, scope: yt.SearchScope) => yt.search(query, scope));
  handle('yt:suggestions', (query: string) => yt.suggestions(query));
  handle('yt:home', () => yt.home());
  handle('yt:homeMore', () => yt.homeMore());
  handle('yt:explore', () => yt.explore());
  handle('yt:browse', (link) => yt.browse(link));
  handle('yt:artist', (id: string) => yt.artist(id));
  handle('yt:artistSongs', (id: string) => yt.artistAllSongs(id));
  handle('yt:collection', (target) => yt.collection(target));
  handle('yt:radio', (id: string) => yt.radio(id));
  handle('yt:related', (id: string) => yt.related(id));
  handle('yt:squareArtwork', (id: string) => yt.squareArtwork(id));
  handle('lyrics:get', (track: Track, duration?: number) => lyrics(track, duration));
  handle('stream:prefetch', (id: string) => prefetch(id));
  handle('stream:invalidate', (id: string) => invalidate(id));

  // Bibliothèque locale
  handle('library:load', () => loadLibrary());
  handle('library:save', (state: LibraryState) => writeJSON('library.json', state));
  handle('settings:apply', async (settings: LibraryState['settings']) => {
    yt.configure({ lang: settings.language, location: settings.region });
    setQuality(settings.highQuality);
  });

  // Compte
  handle('account:get', async () => {
    if (!(await loadCookie())) return { signedIn: false };
    const info = await yt.accountInfo().catch(() => ({}));
    return { signedIn: true, ...info };
  });
  handle('account:login', () => login());
  handle('account:logout', () => logout());
  handle('account:liked', () => yt.likedSongs());
  handle('account:playlists', () => yt.accountPlaylists());
  handle('account:like', (id: string, liked: boolean) => yt.setLike(id, liked));
  handle('account:createPlaylist', (name: string, ids: string[]) => yt.createAccountPlaylist(name, ids));
  handle('account:addToPlaylist', (playlistId: string, ids: string[]) => yt.addToAccountPlaylist(playlistId, ids));

  // Import
  handle('import:link', (link: string) => importer.fromLink(link));
  handle('import:file', async () => {
    const picked = await dialog.showOpenDialog(window!, {
      title: 'Importer une playlist',
      filters: [{ name: 'Exports de playlists', extensions: ['csv', 'tsv', 'txt', 'json'] }],
      properties: ['openFile', 'multiSelections'],
    });
    const playlists: ImportedPlaylist[] = [];
    for (const filePath of picked.filePaths) {
      playlists.push(...importer.fromFile(await fs.readFile(filePath, 'utf8'), path.basename(filePath)));
    }
    return playlists;
  });
  handle('import:run', (playlists: ImportedPlaylist[], toAccount: boolean) => runImport(playlists, toAccount));
  handle('import:match', (wanted) => match(wanted));
  handle('import:cancel', () => { importCancelled = true; });

  // Bibliothèque de l'iPhone (QR code sur le réseau local, ou fichier exporté)
  handle('phone:receive', () => startReceiving((library: any) => {
    sendToUI('phone:library', library);
    const playlists = Array.isArray(library?.playlists) ? library.playlists.length : 0;
    const tracks = new Set([...(library?.liked ?? []), ...(library?.addedTracks ?? []), ...(library?.playlists ?? []).flatMap((p: any) => p.tracks ?? [])].map((t: any) => t?.id)).size;
    return { playlists, tracks };
  }));
  handle('phone:stop', () => stopReceiving());
  handle('phone:openFile', async () => {
    const picked = await dialog.showOpenDialog(window!, {
      title: 'Ouvrir la bibliothèque exportée depuis l’iPhone',
      filters: [{ name: 'Bibliothèque Nova', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (!picked.filePaths[0]) return null;
    const parsed = JSON.parse(await fs.readFile(picked.filePaths[0], 'utf8'));
    return parsed.library ?? parsed;
  });

  // Concerts
  handle('concerts:search', (options) => searchConcerts(options));

  // Jam
  handle('jam:host', (name: string) => jam.host(name));
  handle('jam:broadcast', (message: unknown) => jam.broadcast(message));
  handle('jam:browse', () => jam.browse());
  handle('jam:stopBrowsing', () => jam.stopBrowsing());
  handle('jam:join', (address: string, port: number, name: string) => jam.join(address, port, name));
  handle('jam:toHost', (message: unknown) => jam.toHost(message));
  handle('jam:stop', () => jam.stop());

  handle('shell:open', (url: string) => shell.openExternal(url));

  await createWindow();
});

app.on('window-all-closed', () => {
  jam.stop();
  app.quit();
});
