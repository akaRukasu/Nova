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
