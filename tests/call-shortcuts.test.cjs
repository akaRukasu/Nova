const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

test('call shortcuts leave through Discord and toggle its camera state in both directions', async () => {
  let channel = 'voice', video = false, left = 0;
  const errors = [], events = [];
  const common = {
    SelectedChannelStore: { getVoiceChannelId: () => channel },
    MediaEngineStore: { isVideoEnabled: () => video },
    FluxDispatcher: { dispatch: event => { events.push(JSON.parse(JSON.stringify(event))); video = event.enabled; } },
  };
  const window = { localStorage: { getItem: () => null }, fetch() {}, addEventListener() {},
    Vencord: { Webpack: { Common: common, waitFor() {}, findByProps(...props) {
      assert.deepEqual(props, ['disconnect', 'selectVoiceChannel']);
      return { disconnect: () => { left++; channel = null; } };
    } } } };
  window.top = window;
  vm.runInNewContext(readFileSync('mod/novacord.js', 'utf8'), { window,
    location: { hostname: 'discord.com' }, navigator: {}, XMLHttpRequest: class {},
    CSSStyleSheet: class { replaceSync() {} }, document: { adoptedStyleSheets: [], readyState: 'loading', addEventListener() {} },
    setTimeout() {}, console: { error: message => errors.push(message) },
  });
  await window.NovaCord.runShortcut('toggleCamera');
  await window.NovaCord.runShortcut('toggleCamera');
  assert.deepEqual(events, [
    { type: 'MEDIA_ENGINE_SET_VIDEO_ENABLED', enabled: true },
    { type: 'MEDIA_ENGINE_SET_VIDEO_ENABLED', enabled: false },
  ]);
  await window.NovaCord.runShortcut('leaveCall');
  assert.equal(left, 1);
  await window.NovaCord.runShortcut('toggleCamera');
  await window.NovaCord.runShortcut('leaveCall');
  assert.equal(events.length, 2);
  assert.equal(left, 1);
  assert.equal(errors.length, 2);
  assert.ok(errors.every(message => message.includes('Rejoins un appel')));
});
