import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../Nova/Resources/nova-octave.js', import.meta.url), 'utf8');

test('Android without MediaSession reports the actual track, audio clock and autoplay queue control', () => {
  let queueOpened = false;
  const queue = { getAttribute: () => 'Queue', closest: () => null, click() { queueOpened = true; } };
  const title = { textContent: 'Cross Off' };
  const artist = { textContent: 'Mark Morton & Chester Bennington' };
  const cover = { src: 'https://example.com/cover.jpg' };
  const nowPlaying = { querySelector: selector => selector.includes('marquee') ? title : selector === 'p' ? artist : cover };
  const document = {
    querySelector: selector => selector === '[data-np-zoom-host="true"]' ? nowPlaying : null,
    querySelectorAll: selector => selector === 'button[aria-label]' ? [queue] : [],
  };
  const window = { requestAnimationFrame: () => 1, cancelAnimationFrame() {}, Audio: class {} };
  window.__octaveEngine = { isFading: true };
  vm.runInNewContext(source, { window, document, navigator: {}, location: {origin:'https://music.octavestreaming.com'},
    performance, setTimeout, clearTimeout, Map, WeakRef });
  const audio = new window.Audio();
  Object.assign(audio, { duration:253, currentTime:12, paused:false, ended:false, muted:false, readyState:4 });
  let state = window.novaOctave('sample');
  assert.equal(state.title, 'Cross Off');
  assert.equal(state.artist, 'Mark Morton & Chester Bennington');
  assert.equal(state.artwork, cover.src);
  assert.equal(state.position, 12);
  assert.equal(state.playing, true);
  assert.equal(state.audible, true);
  assert.equal(queueOpened, true);
  assert.equal(state.fading, false);
  assert.equal(state.mixing, false); // Un drapeau moteur obsolète ne suspend pas la progression.
  window.__octaveEngine.isFading = false;
  audio.paused = true;
  audio.currentTime = 18;
  state = window.novaOctave('sample');
  assert.equal(state.playing, false);
  assert.equal(state.fading, false);
  assert.equal(state.position, 18);

  audio.paused = false;
  window.__octaveEngine.active = audio;
  window.novaOctave('sample');
  const incoming = new window.Audio();
  Object.assign(incoming, { duration: 178, currentTime: 1.2, paused: false, ended: false, readyState: 4 });
  window.__octaveEngine.active = incoming;
  window.__octaveEngine.isFading = true;
  audio.currentTime = 249;
  state = window.novaOctave('sample');
  assert.equal(state.outgoingPosition, 249);
  assert.equal(state.position, 1.2);
  audio.paused = true;
  title.textContent = 'Titre suivant';
  incoming.currentTime = 4;
  state = window.novaOctave('sample');
  assert.equal(state.fading, false);
  assert.equal(state.outgoingPosition, undefined);
  assert.equal(state.title, 'Titre suivant');
  assert.equal(state.duration, 178);
  assert.equal(state.position, 4);
});
