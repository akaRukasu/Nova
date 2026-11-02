const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

test('imports persist without audio playback and survive an unavailable Discord catalog', async () => {
  const sounds = new Map(), saved = new Map();
  let resumed = 0;
  const db = { transaction() {
    const tx = { objectStore: () => ({
      put(sound) { sounds.set(sound.id, sound); return { result: sound.id }; },
      get(id) { return { result: sounds.get(id) }; },
      getAll() { return { result: [...sounds.values()] }; },
    }) };
    queueMicrotask(() => tx.oncomplete()); return tx;
  } };
  const window = { localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    NovaCordMedia: { onSender() {} }, Vencord: { Webpack: { Common: { SoundboardStore: { getSounds() { throw new Error('Discord not ready'); } } } } } };
  window.top = window;
  vm.runInNewContext(readFileSync('mod/soundboard.js', 'utf8'), { window, location: { hostname: 'discord.com' },
    navigator: {}, crypto: { randomUUID: () => 'imported', subtle: webcrypto.subtle }, TextEncoder, console: { warn() {} },
    indexedDB: { open() { const request = { result: db }; queueMicrotask(() => request.onsuccess()); return request; } },
    AudioContext: class { state = 'suspended'; createGain() { return { gain: {} }; } resume() { resumed++; throw new Error('No activation'); } async decodeAudioData(data) { assert.equal(new TextDecoder().decode(data), 'audio-bytes'); } },
  });
  delete window.localStorage; // Discord removes this property after startup.
  const file = new File(['audio-bytes'], 'Mon son.wav');
  await window.NovaCordAudio.import(file);
  window.NovaCordAudio.edit('imported', { favorite: true, name: 'Mon favori' });
  const list = JSON.parse(JSON.stringify(await window.NovaCordAudio.list()));
  assert.deepEqual(list, [{ id: 'imported', name: 'Mon favori', local: true, favorite: true }]);
  assert.equal(await sounds.get('imported').blob.text(), 'audio-bytes');
  assert.equal(resumed, 0, 'Import must not wait for an AudioContext resume gesture');
  const onlineId = await window.NovaCordAudio.importOnline(file, 'online-test', '#abcdef');
  window.NovaCordAudio.edit(onlineId, { name: 'Nom personnel' });
  assert.equal(await window.NovaCordAudio.importOnline(file, 'online-test', '#abcdef'), onlineId);
  assert.equal(sounds.size, 2, 'Repeated online imports must not create duplicates');
  const online = (await window.NovaCordAudio.list()).find(sound => sound.id === onlineId);
  assert.equal(online.name, 'Nom personnel'); assert.equal(online.category, 'Myinstants');
  assert.equal(online.source_slug, 'online-test');

});
