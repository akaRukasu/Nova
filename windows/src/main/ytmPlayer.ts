// Lecture par le lecteur officiel de YouTube Music, chargé dans une fenêtre invisible avec le compte
// Google de l'utilisateur. YouTube y fait ses propres vérifications (comme dans un navigateur) ;
// Nova ne fait que piloter le lecteur : charger un titre, lecture/pause, position, volume.
// Deux lecteurs (« decks ») permettent les transitions AutoMix.
import { BrowserWindow, ipcMain, session, type WebContents } from 'electron';
import path from 'node:path';

type Send = (channel: string, ...args: unknown[]) => void;

const decks = new Map<number, BrowserWindow>();
let send: Send = () => {};
let preloadPath = '';
const partition = 'persist:google';

export function setupWebPlayer(sender: Send, preload: string) {
  send = sender;
  preloadPath = preload;
  // Événements du lecteur (position, fin, publicité…), renvoyés à l'interface avec le numéro du lecteur.
  ipcMain.on('ytm:event', (event, payload) => {
    const deck = deckOf(event.sender);
    if (deck != null) send('webplayer:event', deck, payload);
  });
}

function deckOf(contents: WebContents) {
  for (const [deck, window] of decks) if (!window.isDestroyed() && window.webContents.id === contents.id) return deck;
  return undefined;
}

function create(deck: number): BrowserWindow {
  const existing = decks.get(deck);
  if (existing && !existing.isDestroyed()) return existing;
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 760,
    title: 'YouTube Music',
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      preload: preloadPath,
      contextIsolation: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // Navigateur ordinaire (sans la mention « Electron »), comme Chrome.
  window.webContents.setUserAgent(window.webContents.getUserAgent().replace(/ Electron\/\S+/, '').replace(/ nova-windows\/\S+/i, ''));
  // Page de consentement aux cookies (Europe) : montrée une fois, l'utilisateur choisit, puis cachée.
  window.webContents.on('did-navigate', (_event, url) => {
    if (/consent\.(youtube|google)\.com/.test(url)) {
      window.setTitle('YouTube : choisis tes préférences de cookies, puis la musique démarre');
      window.show();
      send('webplayer:consent', true);
    } else if (url.startsWith('https://music.youtube.com') && window.isVisible()) {
      window.hide();
      send('webplayer:consent', false);
    }
  });
  window.on('close', (event) => {
    // Fermer la fenêtre de consentement la cache seulement : le lecteur reste disponible.
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  decks.set(deck, window);
  return window;
}

let quitting = false;
export function destroyWebPlayers() {
  quitting = true;
  for (const window of decks.values()) if (!window.isDestroyed()) window.destroy();
  decks.clear();
}

export async function webLoad(deck: number, videoId: string, startAt: number, volume: number) {
  const window = create(deck);
  const time = startAt > 1 ? `&t=${Math.floor(startAt)}` : '';
  window.webContents.send('ytm:command', { type: 'expect', videoId, volume });
  // NOVA_WEBPLAYER_URL : page de test locale (vérification automatique du pilotage).
  const base = process.env.NOVA_WEBPLAYER_URL ?? 'https://music.youtube.com/watch';
  await window.loadURL(`${base}?v=${encodeURIComponent(videoId)}${time}`).catch(() => undefined);
  window.webContents.send('ytm:command', { type: 'expect', videoId, volume });
}

export function webCommand(deck: number, command: { type: string; value?: number }) {
  const window = decks.get(deck);
  if (window && !window.isDestroyed()) window.webContents.send('ytm:command', command);
}

/** Fenêtre du lecteur affichée (pour vérifier une publicité, un message de YouTube…). */
export function showWebPlayer(deck: number) {
  const window = decks.get(deck);
  window?.show();
  window?.focus();
}

export async function clearWebPlayerData() {
  await session.fromPartition(partition).clearCache();
}

export const webPreloadPath = (here: string) => path.join(here, '../preload/ytmPreload.cjs');
