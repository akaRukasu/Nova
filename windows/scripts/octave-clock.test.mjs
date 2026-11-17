import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../Nova/Resources/nova-octave.js', import.meta.url), 'utf8')
  .split('  const session = navigator.mediaSession;')[0] + '\n})();';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function playerClock(nativeFrame) {
  const window = { requestAnimationFrame: nativeFrame, cancelAnimationFrame() {} };
  vm.runInNewContext(source, {window,location:{origin:'https://music.octavestreaming.com'},
    performance,setTimeout,clearTimeout,Map});
  return window;
}

test('an off-screen player continues its animation clock and cancellation remains effective', async () => {
  const clock = playerClock(() => 1);
  let calls = 0;
  clock.requestAnimationFrame(() => calls++);
  const cancelled = clock.requestAnimationFrame(() => calls++);
  clock.cancelAnimationFrame(cancelled);
  await wait(75);
  assert.equal(calls,1);
});

test('a native animation callback and its fallback never execute the frame twice', async () => {
  let native;
  const clock = playerClock(callback => { native = callback; return 1; });
  let calls = 0;
  clock.requestAnimationFrame(() => calls++);
  native(12);
  await wait(75);
  assert.equal(calls,1);
});
