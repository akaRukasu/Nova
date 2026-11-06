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

// MARK: AutoMix — écoute du titre (tempo, temps, fin), tempo réglable, filtre des basses

/** Mesure en continu (niveau, flux spectral) toutes les 256 valeurs ; même calcul que dans Nova (analysis.ts). */
function createMeter(sampleRate: number) {
  const size = 512, hop = 256;
  const reverse = new Uint32Array(size);
  for (let i = 0; i < size; i++) { let r = 0; for (let b = 0; b < 9; b++) r |= ((i >> b) & 1) << (8 - b); reverse[i] = r; }
  const cos = new Float64Array(size / 2).map((_, i) => Math.cos((2 * Math.PI * i) / size));
  const sin = new Float64Array(size / 2).map((_, i) => -Math.sin((2 * Math.PI * i) / size));
  const window = new Float64Array(size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  const weights = new Float64Array(size / 2).map((_, i) => ((i * sampleRate) / size < 250 ? 3 : 1));
  const buffer = new Float64Array(size), re = new Float64Array(size), im = new Float64Array(size), previous = new Float64Array(size / 2);
  let filled = 0, first = true;
  return (samples: Float32Array, emit: (index: number, rms: number, flux: number) => void) => {
    for (let s = 0; s < samples.length; s++) {
      buffer[filled++] = samples[s];
      if (filled < size) continue;
      let energy = 0;
      for (let i = 0; i < size; i++) { energy += buffer[i] * buffer[i]; re[reverse[i]] = buffer[i] * window[i]; im[reverse[i]] = 0; }
      for (let half = 1; half < size; half *= 2) {
        const step = size / (half * 2);
        for (let start = 0; start < size; start += half * 2) {
          for (let k = 0; k < half; k++) {
            const a = start + k, b = a + half, c = cos[k * step], d = sin[k * step];
            const tr = c * re[b] - d * im[b], ti = c * im[b] + d * re[b];
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          }
        }
      }
      let flux = 0;
      for (let i = 1; i < size / 2; i++) {
        const value = Math.log1p(100 * Math.hypot(re[i], im[i]));
        if (!first && value > previous[i]) flux += (value - previous[i]) * weights[i];
        previous[i] = value;
      }
      first = false;
      emit(s, Math.sqrt(energy / size), flux);
      buffer.copyWithin(0, hop);
      filled = size - hop;
    }
  };
}

let audio: { element: HTMLVideoElement; context: AudioContext; bass: BiquadFilterNode } | null = null;
let measures: number[][] = [];

/** Le son de la page passe par Nova : mesuré pendant la lecture, avec un filtre des basses pour les transitions. */
function setupAudio(element: HTMLVideoElement) {
  if (audio?.element === element) return;
  try {
    const context = new AudioContext();
    const source = context.createMediaElementSource(element);
    const bass = context.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = 200;
    bass.gain.value = 0;
    source.connect(bass).connect(context.destination);
    const tap = context.createScriptProcessor(2048, 2, 1);
    const factor = Math.max(1, Math.round(context.sampleRate / 11025));
    const rate = context.sampleRate / factor;
    const meter = createMeter(rate);
    const reduced = new Float32Array(Math.ceil(2048 / factor));
    tap.onaudioprocess = (event) => {
      event.outputBuffer.getChannelData(0).fill(0);
      if (!video || video.paused || isAd() || video.playbackRate !== 1 && Math.abs(video.playbackRate - 1) > 0.001) return;
      const left = event.inputBuffer.getChannelData(0);
      const right = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : left;
      let n = 0;
      for (let i = 0; i + factor <= left.length; i += factor) {
        let sum = 0;
        for (let j = 0; j < factor; j++) sum += left[i + j] + right[i + j];
        reduced[n++] = sum / (2 * factor);
      }
      // Position du début de ce bloc dans le titre (le bloc vient d'être joué).
      const blockStart = video.currentTime - left.length / context.sampleRate;
      meter(reduced.subarray(0, n), (index, rms, flux) => {
        const time = blockStart + (index + 1 - 512) / rate;
        if (time >= 0) measures.push([Math.round(time * 1000) / 1000, rms, flux]);
      });
    };
    source.connect(tap);
    tap.connect(context.destination);
    void context.resume();
    audio = { element, context, bass };
  } catch {
    // Son déjà relié ailleurs par la page : pas de mesure ni de filtre, la lecture continue normalement.
    audio = { element, context: null as unknown as AudioContext, bass: null as unknown as BiquadFilterNode };
  }
}

// Mesures envoyées à Nova une fois par seconde (taux : 11 025 ou 12 000 valeurs par seconde ÷ 256).
setInterval(() => {
  if (!measures.length || !audio?.context) return;
  ipcRenderer.send('ytm:event', { type: 'measures', videoId: currentId(), expected, frameRate: audio.context.sampleRate / Math.max(1, Math.round(audio.context.sampleRate / 11025)) / 256, frames: measures });
  measures = [];
}, 1000);

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
  if (found && !found.paused) setupAudio(found);
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
    case 'rate':
      // Tempo calé sur le titre précédent, sans changer la hauteur des notes.
      if (video && command.value) { video.preservesPitch = true; video.playbackRate = command.value; }
      break;
    case 'bass':
      if (audio?.bass && command.value != null) audio.bass.gain.setTargetAtTime(command.value, audio.context.currentTime, 0.05);
      break;
  }
});
