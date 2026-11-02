const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

test('call shortcuts leave through Discord and toggle its camera state in both directions', async () => {
  let channel = 'voice', video = false, left = 0, blockCamera = false, clock = 0;
  const errors = [], events = [];
  const camera = { disabled: false, getClientRects: () => [{}], getAttribute: key => key === 'aria-label' ? (video ? 'Désactiver la caméra' : 'Activer la caméra') : null, click() { video = !video; events.push(video); } };
  const common = {
    SelectedChannelStore: { getVoiceChannelId: () => channel },
    MediaEngineStore: { isVideoEnabled: () => video },
    FluxDispatcher: { dispatch: event => { events.push(event.enabled); if (!blockCamera) video = event.enabled; } },
  };
  const window = { localStorage: { getItem: () => null }, fetch() {}, addEventListener() {},
    Vencord: { Webpack: { Common: common, waitFor() {}, findByProps(...props) {
      assert.deepEqual(props, ['disconnect', 'selectVoiceChannel']);
      return { disconnect: () => { left++; channel = null; } };
    } } } };
  window.top = window;
  vm.runInNewContext(readFileSync('mod/novacord.js', 'utf8'), { window,
    location: { hostname: 'discord.com' }, navigator: {}, XMLHttpRequest: class {},
    CSSStyleSheet: class { replaceSync() {} }, document: { adoptedStyleSheets: [], readyState: 'loading', addEventListener() {}, querySelectorAll: () => blockCamera ? [] : [camera] },
    Date: class extends Date { static now() { return clock; } },
    setTimeout(callback, delay) { clock += delay; queueMicrotask(callback); }, console: { error: message => errors.push(message) },
  });
  await window.NovaCord.runShortcut('toggleCamera');
  await window.NovaCord.runShortcut('toggleCamera');
  assert.deepEqual(events, [true, false], 'Confirm the Discord camera state in both directions');
  blockCamera = true;
  await window.NovaCord.runShortcut('toggleCamera');
  assert.match(errors.shift(), /n’a pas confirmé/, 'An ignored camera command must report failure');
  assert.equal(video, false);
  events.splice(2);
  blockCamera = false;
  await window.NovaCord.runShortcut('leaveCall');
  assert.equal(left, 1);
  await window.NovaCord.runShortcut('toggleCamera');
  await window.NovaCord.runShortcut('leaveCall');
  assert.equal(events.length, 2);
  assert.equal(left, 1);
  assert.equal(errors.length, 2);
  assert.ok(errors.every(message => message.includes('Rejoins un appel')));
});
