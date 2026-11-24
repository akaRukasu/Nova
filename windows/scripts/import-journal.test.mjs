import assert from 'node:assert/strict';
import test from 'node:test';
import { ImportJournal } from '../dist/shared/importJournal.js';
import { configureOctaveCatalog } from '../dist/main/octave.js';
import { runImport } from '../dist/main/importRun.js';

test('imports keep unresolved Octave matches across reloads and recover without counting the track twice', async () => {
  let disk = [];
  const read = async () => structuredClone(disk);
  const write = async entries => { disk = structuredClone(entries); };
  const journal = new ImportJournal(read, write);
  const playlist = { name: 'Import regression', source: 'CSV',
    tracks: [{ title: 'Example', artist: 'Example Artist', duration: 120, youtubeId: 'abcdefghijk' }] };
  const progress = [];
  const options = { emit: p => progress.push(structuredClone(p)), cancelled: () => false,
    saveMatches: async () => {}, saveJournal: entries => journal.record(entries), width: 1 };
  configureOctaveCatalog(async () => new Response(JSON.stringify({ tracks: [] })));
  try {
    const result = await runImport([playlist], false, options);
    assert.equal(result[0].tracks.length, 1);
    assert.equal(progress.at(-1).matched, 1);
    const restored = new ImportJournal(read, write);
    const [entry] = await restored.load();
    assert.equal(entry.status, 'youtube');
    assert.equal(entry.attempts, 2);
    assert.equal(entry.track.youtubeId, 'abcdefghijk');
    configureOctaveCatalog(async () => new Response(JSON.stringify({ tracks: [
      { id: 123, title: 'Example', artist: { name: 'Example Artist' }, album: { id: 456, title: 'Example' }, duration: 120 },
    ] })));
    const corrected = await runImport([{ ...playlist, tracks: [entry.track] }], false, options);
    assert.equal(corrected[0].tracks[0].id, 'octave:123');
    assert.equal(corrected[0].tracks[0].youtubeId, 'abcdefghijk');
    assert.equal((await restored.load()).length, 1);
    assert.equal((await restored.load())[0].status, 'resolved');
    assert.equal((await restored.load())[0].attempts, 3);
    await Promise.all([journal.record([{ ...entry, id: 'a', attempts: 1 }]), journal.record([{ ...entry, id: 'b', attempts: 1 }])]);
    assert.equal((await journal.load()).length, 3);
  } finally {
    configureOctaveCatalog((...args) => fetch(...args));
  }
});

