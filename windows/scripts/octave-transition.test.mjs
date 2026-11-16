import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
const script = readFileSync(new URL('../../Nova/Resources/nova-octave-transition.js', import.meta.url), 'utf8');
test('polling native AutoMix preserves short, long and user-selected transition plans', () => {
  let touched = 0;
  const preview = {trackId:'1',mixes:false,openAt:174,seamEnd:175};
  const window = {__octaveAutomix:{preview}};
  runInNewContext(script, {window, location:{origin:'https://music.octavestreaming.com'},
    document:{querySelectorAll() {touched++;throw new Error('Do not open menus during playback');}}});
  assert.equal(window.novaOctaveTransition('1',150), preview);
  preview.mixes = true; preview.openAt = 165;
  assert.equal(window.novaOctaveTransition('1',151), preview);
  assert.equal(window.novaOctaveTransition('2',152), null);
  assert.equal(touched,0);
});

test('an automatic handoff preserves the actual ending and keeps the native mix curves', () => {
  const calls = [];
  let tick;
  const audio = { duration: 240, currentTime: 202, playbackRate: 1, paused: false, ended: false };
  let state = { next(...args) { calls.push(args); } };
  const window = { __octaveEngine: { active: audio }, __octavePlayerStore: {
    getState: () => state, setState(update) { state = { ...state, ...update }; },
  }};
  runInNewContext(script, {window,location:{origin:'https://music.octavestreaming.com'},setTimeout(callback) { tick = callback; return 1; },clearTimeout() {}});
  window.novaOctaveTransition('1');
  const render = { appleStyleId: 8, openAt: 202, maxWindow: 8, tempo: 120 };
  const automatic = () => state.next(true, 8, true, 1.01, 0, false, {outBar: 2}, render);
  automatic();
  assert.equal(calls.length, 0);
  audio.currentTime = 231;
  tick();
  assert.equal(calls.length, 0);
  audio.currentTime = 232;
  tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 8);
  assert.equal(calls[0][7].openAt, 232);
  assert.equal(calls[0][7].maxWindow, 8);
  assert.equal(calls[0][7].appleStyleId, 8);
  assert.equal(calls[0][7].tempo, 120);
  assert.equal(render.openAt, 202);
  audio.currentTime = 20;
  state.next(false, 3);
  assert.equal(calls.length, 2);
  audio.ended = true;
  automatic();
  assert.equal(calls.length, 3);
});
