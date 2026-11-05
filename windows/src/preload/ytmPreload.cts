// Script chargé dans la page du lecteur YouTube Music (fenêtre invisible) : il pilote l'élément vidéo
// de la page (lecture, pause, position, volume) et renvoie son état à Nova.
import { ipcRenderer } from 'electron';

let expected = '';
let volume = 0.8;
let video: HTMLVideoElement | null = null;
let lastSent = 0;

const currentId = () => new URL(location.href).searchParams.get('v') ?? '';
const isAd = () => !!document.querySelector('#movie_player.ad-showing, .ad-showing, .ytp-ad-player-overlay');

function report(type: string) {
  if (!video) return;
  ipcRenderer.send('ytm:event', {
    type,
    time: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    paused: video.paused,
    ad: isAd(),
    videoId: currentId(),
    expected,
  });
}

function applyVolume() {
  if (video && Math.abs(video.volume - volume) > 0.01) video.volume = volume;
}

function attach(element: HTMLVideoElement) {
  if (video === element) return;
  video = element;
  element.addEventListener('playing', () => {
    // YouTube Music enchaîne seul sur son propre titre suivant : Nova garde la main sur la file.
    if (expected && currentId() && currentId() !== expected && !isAd()) {
      element.pause();
      return;
    }
    applyVolume();
    report('playing');
  });
  element.addEventListener('pause', () => report('pause'));
  element.addEventListener('waiting', () => report('waiting'));
  element.addEventListener('ended', () => { if (!isAd()) report('ended'); });
  element.addEventListener('error', () => report('error'));
  element.addEventListener('loadedmetadata', () => { applyVolume(); report('loadedmetadata'); });
  element.addEventListener('volumechange', applyVolume);
  // La page démarre parfois la lecture avant que ce script ne s'y accroche.
  if (!element.paused) setTimeout(() => report('playing'), 0);
  element.addEventListener('timeupdate', () => {
    if (Date.now() - lastSent < 240) return;
    lastSent = Date.now();
    report('timeupdate');
  });
}

// Publicités : son coupé pendant qu'elles passent, et « Passer » pressé dès que YouTube le propose.
const skipButtons = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, button[id^="skip-button"]';
let mutedForAd = false;

function handleAds() {
  if (!video) return;
  if (isAd()) {
    if (!video.muted) { video.muted = true; mutedForAd = true; }
    const skip = document.querySelector<HTMLElement>(skipButtons);
    if (skip && skip.offsetParent !== null) skip.click();
  } else if (mutedForAd) {
    video.muted = false;
    mutedForAd = false;
  }
}

// L'élément vidéo apparaît (et peut être remplacé) au fil de la navigation dans la page.
setInterval(() => {
  const found = document.querySelector('video');
  if (found) attach(found);
  handleAds();
}, 300);

ipcRenderer.on('ytm:command', (_event, command: { type: string; value?: number; videoId?: string; volume?: number }) => {
  switch (command.type) {
    case 'expect':
      expected = command.videoId ?? '';
      if (command.volume != null) volume = command.volume;
      break;
    case 'play':
      void video?.play().catch(() => report('error'));
      break;
    case 'pause':
      video?.pause();
      break;
    case 'seek':
      if (video && command.value != null) video.currentTime = command.value;
      break;
    case 'volume':
      if (command.value != null) volume = command.value;
      applyVolume();
      break;
    case 'stop':
      expected = '';
      video?.pause();
      break;
  }
});
