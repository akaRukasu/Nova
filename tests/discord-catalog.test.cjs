const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

test('Discord sounds load with a cold store, normalize native catalogs, and preserve imports on failure', async () => {
  let native = new Map(), guild = '123', user = 'user-1', fail = false;
  const requests = [], saved = new Map();
  const common = {
    UserStore: { getCurrentUser: () => ({ id: user }) }, SelectedGuildStore: { getGuildId: () => guild },
    SoundboardStore: { getSounds: () => native },
    RestAPI: { async get({ url }) {
      requests.push(url); if (fail) throw new Error('Discord offline');
      return { ok: true, body: url.includes('default') ? [{ sound_id: '1', name: 'Quack' }] : { items: [{ sound_id: '99', name: 'Serveur' }] } };
    } },
  };
  const db = { transaction() {
    const tx = { objectStore: () => ({ getAll: () => ({ result: [{ id: 'personal', name: 'Mon son' }] }) }) };
    queueMicrotask(() => tx.oncomplete()); return tx;
  } };
  const window = { NovaCordMedia: { onSender() {} }, Vencord: { Webpack: { Common: common } },
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) } };
  window.top = window;
  vm.runInNewContext(readFileSync('mod/soundboard.js', 'utf8'), { window, location: { hostname: 'discord.com' },
    navigator: {}, console, indexedDB: { open() { const request = { result: db }; queueMicrotask(() => request.onsuccess()); return request; } } });
  const list = async () => JSON.parse(JSON.stringify(await window.NovaCordAudio.list()));
  const tick = () => new Promise(resolve => setImmediate(resolve));
  assert.equal((await list())[0].id, 'personal'); await tick();
  await list(); await tick();
  let sounds = await list();
  assert.deepEqual(sounds.map(sound => sound.id), ['personal', 'discord:1', 'discord:99']);
  assert.deepEqual(requests, ['/soundboard-default-sounds', '/guilds/123/soundboard-sounds']);
  await list(); assert.equal(requests.length, 2, 'Polling must not repeatedly request Discord');
  for (const shape of [
    [{ soundId: '100', name: 'Flat' }],
    new Map([['guild', [{ soundId: '100', name: 'Flat' }]]]),
    new Map([['guild', new Map([['100', { soundId: '100', name: 'Flat' }]])]]),
    { guild: { '100': { sound_id: '100', name: 'Flat' }, bad: null } },
  ]) { native = shape; sounds = await list(); assert.equal(sounds.filter(s => s.id === 'discord:100').length, 1); }
  common.SoundboardStore.getOverlaySerializedState = () => ({ soundboardSounds: { guild: [{ soundId: '101', name: 'Overlay' }] } });
  sounds = await list(); assert.ok(sounds.some(s => s.id === 'discord:101'));
  common.SoundboardStore.getSounds = () => { throw new Error('Store unavailable'); };
  guild = '456'; fail = true; await list(); await tick();
  sounds = await list(); assert.ok(sounds.some(s => s.id === 'personal')); assert.ok(sounds.some(s => s.id === 'discord:99'));
  assert.ok(window.NovaCordAudio.status().discordCatalog.error);
  user = 'user-2'; await list(); await tick(); sounds = await list();
  assert.ok(!sounds.some(s => s.id === 'discord:99'), 'Account changes clear the old fallback catalog');
});
