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
  element.addEventListener('timeupdate', () => {
    if (Date.now() - lastSent < 240) return;
    lastSent = Date.now();
    report('timeupdate');
  });
}

// L'élément vidéo apparaît (et peut être remplacé) au fil de la navigation dans la page.
setInterval(() => {
  const found = document.querySelector('video');
  if (found) attach(found);
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
