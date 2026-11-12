// Nova pour Windows : processus principal.
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, nativeTheme, safeStorage, screen, session, shell } from 'electron';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImportedPlaylist, ImportProgress, LibraryState, Track } from '../shared/types.js';
import type { HistorySnapshot } from '../shared/historySync.js';
import { defaultSettings } from '../shared/types.js';
import { isOctaveId, type OctaveCommand } from '../shared/octave.js';
import { searchConcerts } from './concerts.js';
import { allowEverywhere, networkStatus } from './firewall.js';
import { palette } from './palette.js';
import * as importer from './importer.js';
import { runImport as runImports } from './importRun.js';
import * as jam from './jam.js';
import { lyrics } from './lyrics.js';
import { currentPairing, getRemoteState, pairingLink, setRemoteHandler, setRemoteState, startSyncServer, stopSyncServer, unpair } from './phoneSync.js';
import { loadMatches, match, savedMatches } from './matcher.js';
import * as octave from './octave.js';
import { findYouTubeRecording, syncOctaveListen } from './octaveHistory.js';
import { OctavePlayer } from './octavePlayer.js';
import { handleStreams, invalidate, prefetch, registerScheme, setQuality, streamError } from './streams.js';
import './evalNode.js';
import * as yt from './yt.js';
import { destroyWebPlayers, setupWebPlayer, showWebPlayer, webCommand, webLoad } from './ytmPlayer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = () => app.getPath('userData');
const file = (name: string) => path.join(dataDir(), name);

registerScheme();
// Le lecteur officiel de YouTube Music démarre sans clic (fenêtre invisible).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Une seule fenêtre de Nova à la fois : une deuxième ouverture s'arrête tout de suite et réveille la première.
if (!app.requestSingleInstanceLock()) app.exit(0);

// Affichage de secours (sans accélération graphique) : activé tout seul si la fenêtre restait vide.
const safeDisplayFlag = () => file('affichage-secours');
const safeDisplay = existsSync(safeDisplayFlag());
if (safeDisplay) app.disableHardwareAcceleration();

let window: BrowserWindow | null = null;
const sendToUI = (channel: string, ...args: unknown[]) => window?.webContents.send(channel, ...args);
const pendingHistory = new Map<string, (value: HistorySnapshot) => void>();
function exchangeHistory(incoming: HistorySnapshot): Promise<HistorySnapshot> {
  if (!uiReady || !window || window.isDestroyed()) return Promise.reject(new Error('Bibliothèque Nova indisponible.'));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pendingHistory.delete(id);
      reject(new Error('La bibliothèque Nova ne répond pas.'));
    }, 8000);
    pendingHistory.set(id, (snapshot) => {
      clearTimeout(timer);
      pendingHistory.delete(id);
      resolve(snapshot);
    });
    sendToUI('phone:history', id, incoming);
  });
}
jam.setSender(sendToUI);
const octavePlayer = new OctavePlayer(
  () => window,
  (track, playedAt) => {
    sendToUI('octave:played', track, playedAt);
    void syncOctaveListen(track, youtubeHistoryEnabled).catch(() => sendToUI('octave:sync-error'));
  },
  (status) => sendToUI('octave:status', status),
  (visible) => sendToUI('octave:panel', visible),
  () => sendToUI('octave:connected'),
);

const mediaShortcuts = [['MediaPlayPause', 'toggle'], ['MediaNextTrack', 'next'], ['MediaPreviousTrack', 'previous']] as const;

function claimMediaShortcuts() {
  for (const [key, action] of mediaShortcuts) {
    if (!globalShortcut.isRegistered(key)) globalShortcut.register(key, () => sendToUI('media:key', action));
  }
}

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

async function youtubeHistoryEnabled(): Promise<boolean> {
  if (!await loadCookie()) return false;
  const { settings } = await loadLibrary();
  return settings.recordHistory && settings.syncOctaveToYouTube !== false;
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
  octavePlayer.setAudioSettings(library.settings.octaveAudio);
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

function runImport(playlists: ImportedPlaylist[], toAccount: boolean) {
  importCancelled = false;
  // Quatre recherches en parallèle : rapide, sans saturer YouTube Music.
  return runImports(playlists, toAccount, {
    emit: (progress) => sendToUI('import:progress', progress), cancelled: () => importCancelled,
    saveMatches: (entries) => writeJSON('matches.json', entries), width: 4,
  });
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
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#ffffff' : '#1c1c1e', height: 40 },
    icon: path.join(here, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(here, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      // La musique continue quand la fenêtre est réduite.
      backgroundThrottling: false,
      spellcheck: false,
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
  // Fermer Nova ferme tout, y compris les lecteurs invisibles de YouTube Music.
  window.on('closed', () => {
    window = null;
    app.quit();
  });
  watchStartup(window);
  await window.loadFile(path.join(here, '../renderer/index.html'));
}

// MARK: - Mini lecteur

let mini: BrowserWindow | null = null;

function openMini() {
  if (!window || window.isDestroyed()) return;
  if (mini && !mini.isDestroyed()) return mini.show();
  const dark = nativeTheme.shouldUseDarkColors;
  const width = 428;
  const height = 142;
  mini = new BrowserWindow({
    width,
    height,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: 'Nova',
    backgroundColor: dark ? '#1c1c1e' : '#f5f5f7',
    icon: path.join(here, '../../build/icon.png'),
    webPreferences: { preload: path.join(here, '../preload/preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  mini.setAlwaysOnTop(true, 'floating');
  // En bas à droite de l'écran où se trouvait Nova.
  const area = screen.getDisplayMatching(window.getBounds()).workArea;
  mini.setPosition(area.x + area.width - width - 20, area.y + area.height - height - 20);
  const current = mini;
  current.webContents.on('did-finish-load', async () => {
    current.webContents.send('mini:state', getRemoteState());
    current.webContents.send('mini:theme', (await loadLibrary()).settings.theme);
  });
  current.on('closed', () => {
    mini = null;
    if (window && !window.isDestroyed()) window.show();
  });
  void current.loadFile(path.join(here, '../renderer/index.html'), { hash: 'mini' });
  window.hide();
}

// MARK: - Démarrage surveillé : si l'interface n'apparaît pas, Nova dit pourquoi au lieu de rester vide.

let uiReady = false;
let windowCreatedAt = 0;
const startupProblems: string[] = [];

/** Journal de démarrage (demarrage.log, dans le dossier de Nova) : de quoi trouver la cause d'une fenêtre vide. */
function log(text: string) {
  const line = `${new Date().toISOString()} ${text}\n`;
  void fs.mkdir(dataDir(), { recursive: true }).then(() => fs.appendFile(file('demarrage.log'), line)).catch(() => undefined);
}

function watchStartup(target: BrowserWindow) {
  const contents = target.webContents;
  windowCreatedAt = Date.now();
  uiReady = false;
  // Journal gardé court : au-delà de 200 Ko, l'ancien est mis de côté.
  void fs.stat(file('demarrage.log')).then(async (s) => { if (s.size > 200_000) await fs.rename(file('demarrage.log'), file('demarrage.old.log')); }).catch(() => undefined);
  const note = (text: string) => { startupProblems.push(text); if (startupProblems.length > 40) startupProblems.shift(); log(text); };
  log(`--- Démarrage de Nova ${app.getVersion()} · affichage ${safeDisplay ? 'de secours' : 'normal'} · ${process.getSystemVersion()}`);
  log(`Carte graphique : ${JSON.stringify(app.getGPUFeatureStatus())}`);
  contents.on('did-finish-load', () => log('Page chargée'));
  target.on('show', () => log('Fenêtre affichée'));
  // Si rien n'est prêt au bout de 20 s (page qui ne se charge pas, interface qui ne démarre pas) : Nova le dit.
  setTimeout(() => { if (!uiReady && !target.isDestroyed()) void reportStartup(target); }, 20_000);
  contents.on('console-message', (...args: any[]) => {
    const details = args[0];
    const level = details?.level ?? args[1];
    const message = details?.message ?? args[2];
    if (level === 'error' || level === 3) note(`Console : ${message}${details?.sourceId ? ` (${path.basename(String(details.sourceId))}:${details.lineNumber})` : ''}`);
  });
  contents.on('preload-error', (_event, preloadPath, error) => note(`Pont ${path.basename(preloadPath)} : ${error?.stack ?? error}`));
  contents.on('did-fail-load', (_event, code, description, url) => note(`Chargement impossible (${code} ${description}) : ${url}`));
  contents.on('render-process-gone', (_event, details) => {
    note(`Affichage arrêté : ${details.reason} (code ${details.exitCode})`);
    // L'affichage a planté (mémoire, pilote graphique…) : on le relance plutôt que de laisser une fenêtre vide.
    if (details.reason !== 'clean-exit' && !target.isDestroyed()) setTimeout(() => !target.isDestroyed() && target.webContents.reload(), 1000);
  });
}

app.on('child-process-gone', (_event, details) => {
  if (details.type === 'GPU') log(`Processus graphique arrêté : ${details.reason} (code ${details.exitCode})`);
});

/** L'interface est prête mais la fenêtre reste-t-elle uniforme (rien d'affiché) ? Alors : affichage de secours. */
async function checkDisplay() {
  if (!window || window.isDestroyed() || !window.isVisible() || window.isMinimized() || safeDisplay) return;
  const image = await window.webContents.capturePage().catch(() => undefined);
  let blank = !image || image.isEmpty();
  if (image && !blank) {
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    const colors = new Set<number>();
    // Fenêtre vide = une seule couleur partout. L'interface en a toujours plusieurs (barre latérale, page,
    // textes), même sombre et peu remplie : 48 × 48 points regardés.
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 48; x++) {
        const i = (Math.floor(((y + 0.5) / 48) * height) * width + Math.floor(((x + 0.5) / 48) * width)) * 4;
        colors.add((bitmap[i] >> 4) << 8 | (bitmap[i + 1] >> 4) << 4 | bitmap[i + 2] >> 4);
      }
    }
    blank = colors.size <= 1;
  }
  log(`Vérification de l'affichage : ${blank ? 'fenêtre uniforme' : 'contenu visible'}`);
  if (!blank) return;
  await fs.writeFile(safeDisplayFlag(), `Fenêtre vide détectée le ${new Date().toISOString()}\n`).catch(() => undefined);
  app.relaunch();
  app.exit(0);
}

async function reportStartup(target: BrowserWindow) {
  const details = startupProblems.length ? startupProblems.join('\n') : 'Aucune erreur signalée : l’interface ne répond pas.';
  const logFile = file('demarrage.log');
  await fs.mkdir(dataDir(), { recursive: true }).catch(() => undefined);
  log(`Interface toujours absente après 20 s.`);
  const { response } = await dialog.showMessageBox(target, {
    type: 'error',
    title: 'Nova',
    message: 'Nova n’arrive pas à afficher son interface',
    detail: `${details.slice(0, 1800)}\n\nJournal : ${logFile}`,
    buttons: ['Recharger', 'Repartir d’une bibliothèque vide (la tienne est gardée de côté)', 'Fermer'],
    defaultId: 0,
    noLink: true,
  });
  if (response === 1) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.rename(file('library.json'), file(`library-sauvegarde-${stamp}.json`)).catch(() => undefined);
  }
  if (response === 2) return app.quit();
  startupProblems.length = 0;
  target.webContents.reload();
}

function handle(channel: string, listener: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (_event, ...args) => listener(...args));
}

app.on('second-instance', () => {
  // Nova relancé : si la fenêtre existante est vide ou plantée, elle est rechargée (ou recréée).
  if (!window || window.isDestroyed()) return void createWindow();
  log(`Nova relancé alors qu'il est ouvert (interface prête : ${uiReady})`);
  if (window.webContents.isCrashed() || !uiReady) window.webContents.reload();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  // Relancé peu après l'ouverture : souvent parce que la fenêtre reste vide. On demande (fenêtre de Windows, toujours visible).
  if (Date.now() - windowCreatedAt < 10 * 60_000) void askAboutBlankWindow(window);
});

async function askAboutBlankWindow(target: BrowserWindow) {
  const { response } = await dialog.showMessageBox(target, {
    type: 'question',
    title: 'Nova',
    message: 'La fenêtre de Nova reste vide ?',
    detail: `Affichage de secours : Nova redémarre sans accélération graphique (un peu moins fluide, mais fiable).\nJournal : ${file('demarrage.log')}`,
    buttons: ['Non, tout va bien', 'Recharger', 'Affichage de secours'],
    defaultId: 2,
    cancelId: 0,
    noLink: true,
  });
  log(`Réponse à « fenêtre vide ? » : ${['non', 'recharger', 'secours'][response]}`);
  if (response === 1 && !target.isDestroyed()) target.webContents.reload();
  if (response === 2) {
    await fs.writeFile(safeDisplayFlag(), `Demandé le ${new Date().toISOString()}\n`).catch(() => undefined);
    app.relaunch();
    app.exit(0);
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.akarukasu.nova');
  handleStreams();
  loadMatches(await readJSON('matches.json', {}));
  const cookie = await loadCookie();
  await configureYouTube(cookie);

  // Octave alimente le catalogue Windows. Les identifiants enregistrés avant ce changement restent lisibles.
  handle('yt:search', octave.search);
  handle('yt:suggestions', octave.suggestions);
  handle('yt:home', () => octave.charts(true));
  handle('yt:homeMore', () => ({ shelves: [] }));
  handle('yt:explore', () => octave.charts());
  handle('yt:browse', (link) => yt.browse(link));
  handle('yt:artist', (id: string) => isOctaveId(id) ? octave.artist(id) : yt.artist(id));
  handle('yt:artistSongs', (id: string) => isOctaveId(id) ? octave.artistSongs(id) : yt.artistAllSongs(id));
  handle('yt:collection', (target) => isOctaveId(target.id) ? octave.collection(target) : yt.collection(target));
  handle('yt:radio', (id: string) => isOctaveId(id) ? octave.radio(id) : yt.radio(id));
  handle('yt:related', (id: string) => isOctaveId(id) ? octave.related(id) : yt.related(id));
  handle('yt:squareArtwork', (id: string) => yt.squareArtwork(id));
  handle('art:track', (track: Track) => isOctaveId(track.id) ? octave.trackArtwork(track) : yt.squareArtwork(track.id));
  handle('art:palette', (url: string) => palette(url));
  handle('lyrics:get', (track: Track, duration?: number) => lyrics(track, duration));
  handle('stream:prefetch', (id: string) => prefetch(id));
  handle('stream:invalidate', (id: string) => invalidate(id));
  handle('stream:error', (id: string) => streamError(id));

  // Bibliothèque locale
  handle('library:load', () => loadLibrary());
  handle('library:save', (state: LibraryState) => writeJSON('library.json', state));
  handle('settings:apply', async (settings: LibraryState['settings']) => {
    octavePlayer.setAudioSettings(settings.octaveAudio);
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
  handle('account:createPlaylist', (name: string, ids: string[], privacy?: string) => yt.createAccountPlaylist(name, ids, privacy));
  // Page YouTube Music avec le compte de l'utilisateur (activer « Collaborer », accepter une invitation).
  handle('youtube:open', (url: string) => {
    if (!/^https:\/\/(music|www)\.youtube\.com\//.test(url)) return;
    const page = new BrowserWindow({ width: 1100, height: 800, title: 'YouTube Music', autoHideMenuBar: true, webPreferences: { partition: loginPartition } });
    page.webContents.setUserAgent(page.webContents.getUserAgent().replace(/ Electron\/\S+/, '').replace(/ nova-windows\/\S+/i, ''));
    void page.loadURL(url);
  });
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
  handle('ui:ready', () => {
    uiReady = true;
    log(`Interface prête en ${Date.now() - windowCreatedAt} ms`);
    setTimeout(() => void checkDisplay(), 2500);
  });

  // Bibliothèque de l'iPhone : association par QR code, puis envois automatiques sur le réseau local.
  await startSyncServer(dataDir(), (library: any, phone: string) => {
    sendToUI('phone:library', library, phone);
    const playlists = Array.isArray(library?.playlists) ? library.playlists.length : 0;
    const tracks = new Set([...(library?.liked ?? []), ...(library?.addedTracks ?? []), ...(library?.playlists ?? []).flatMap((p: any) => p.tracks ?? [])].map((t: any) => t?.id)).size;
    return { playlists, tracks };
  }, exchangeHistory).catch(() => undefined);
  ipcMain.handle('phone:history-result', (event, id: string, history: HistorySnapshot) => {
    if (event.sender === window?.webContents) pendingHistory.get(id)?.(history);
  });
  handle('phone:pairing', () => ({ ...currentPairing(), ...pairingLink(), token: undefined }));
  handle('phone:unpair', () => unpair());
  handle('phone:network', () => networkStatus());
  handle('phone:allowNetwork', () => allowEverywhere());
  // Télécommande depuis l'iPhone : l'interface publie son état, reçoit les commandes.
  handle('remote:state', (state: unknown) => {
    setRemoteState(state);
    if (mini && !mini.isDestroyed()) mini.webContents.send('mini:state', state);
  });
  // Mini lecteur : petite fenêtre toujours au premier plan ; la lecture continue dans la fenêtre principale (cachée).
  handle('mini:open', () => openMini());
  handle('mini:close', () => mini?.close());
  handle('mini:command', (command: Record<string, unknown>) => sendToUI('remote:command', { ...command, source: 'mini' }));
  setRemoteHandler((command) => sendToUI('remote:command', command));
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
  handle('octave:open', async (url?: string) => {
    await octavePlayer.open(url);
  });
  handle('octave:hide', () => octavePlayer.hide());
  handle('octave:stop', () => octavePlayer.stop());
  handle('octave:youtube-match', (track: Track) => findYouTubeRecording(track));
  handle('octave:play', (track: Track, request: number, volume: number, position: number) => octavePlayer.play(track, request, volume, position));
  handle('octave:queue-next', (request: number, track: Track) => octavePlayer.queueNext(request, track));
  handle('octave:command', (request: number, command: OctaveCommand) => octavePlayer.command(request, command));
  handle('media:claim', claimMediaShortcuts);

  // Lecteur officiel de YouTube Music (fenêtre invisible), quand la lecture directe est refusée.
  setupWebPlayer(sendToUI, path.join(here, '../preload/ytmPreload.cjs'));
  handle('webplayer:load', (deck: number, id: string, startAt: number, volume: number) => webLoad(deck, id, startAt, volume));
  handle('webplayer:command', (deck: number, command: { type: string; value?: number }) => webCommand(deck, command));
  handle('webplayer:show', (deck: number) => showWebPlayer(deck));

  await createWindow();
  octavePlayer.warmUp();
});

app.on('before-quit', () => {
  octavePlayer.destroy();
  destroyWebPlayers();
});

app.on('window-all-closed', () => {
  jam.stop();
  destroyWebPlayers();
  globalShortcut.unregisterAll();
  stopSyncServer();
  app.quit();
});
