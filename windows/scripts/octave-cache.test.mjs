import test from 'node:test';
import assert from 'node:assert/strict';
import { configureOctaveCatalog, configureOctaveRecordings, configureOctaveLibrary, findRecording } from '../dist/main/octave.js';

test('confirmed recordings survive restart, share concurrent lookups, and changed metadata is checked again', async () => {
  let calls = 0, saved = {};
  const source = {id: 'cache-video1', title: 'Song', artist: 'Artist', duration: 120};
  const result = {id: 42, title: 'Song', artist: {id: 7, name: 'Artist'}, duration: 120,
    album: {id: 8, title: 'Album'}};
  configureOctaveCatalog(async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 15));
    return Response.json({tracks: [result]});
  });
  configureOctaveRecordings({}, async entries => { saved = structuredClone(entries); });
  const found = await Promise.all(Array.from({length: 8}, () => findRecording(source)));
  assert.equal(calls, 1);
  assert.ok(found.every(track => track?.id === 'octave:42'));
  await new Promise(resolve => setTimeout(resolve, 0));
  configureOctaveRecordings(saved);
  assert.equal((await findRecording(source))?.id, 'octave:42');
  assert.equal(calls, 1);
  assert.equal(await findRecording({...source, title: 'Different song'}), undefined);
  assert.ok(calls > 1);
  const previous = calls;
  await findRecording({...source, title: 'Different song'});
  assert.ok(calls > previous, 'A missing match must not become a permanent negative cache');
});

test('a failed first query still tries the alternate artist credits', async () => {
  configureOctaveRecordings({});
  let calls = 0;
  configureOctaveCatalog(async () => {
    if (++calls === 1) throw new Error('temporary network failure');
    return Response.json({tracks: [{id: 43, title: 'Song', artist: {id: 7, name: 'Artist'}, duration: 120, album: {id: 8, title: 'Album'}}]});
  });
  const found = await findRecording({id: 'cache-video2', title: 'Song', artist: 'Artist & Guest', duration: 120});
  assert.equal(found?.id, 'octave:43');
  assert.equal(calls, 2);
});

test('an Autoplay label does not pollute matching, and a confirmed library recording avoids network search', async () => {
  const wanted = {id: 'octave:played-old', title: "Let's Get This Party Started", artist: 'Korn · Autoplay', album: 'Issues', duration: 221.24};
  const recording = {id:'octave:15175513', title:wanted.title, artist:'Korn', album:'Issues', albumId:'octave:1398831', duration:221};
  let calls = 0;
  configureOctaveRecordings({});
  configureOctaveLibrary([recording]);
  configureOctaveCatalog(async () => { calls++; throw new Error('Offline'); });
  assert.equal((await findRecording(wanted))?.id, recording.id);
  assert.equal(calls, 0);
  configureOctaveLibrary([]);
  configureOctaveRecordings({});
  configureOctaveCatalog(async () => { calls++; return Response.json({tracks:[{id:15175513,title:recording.title,
    artist:{name:'Korn'},album:{id:1398831,title:'Issues'},duration:221}]}); });
  assert.equal((await findRecording(wanted))?.id, recording.id);
  assert.equal(calls, 1);
  configureOctaveLibrary([{...recording, id:'octave:99',artist:'Other band'}]);
  configureOctaveRecordings({});
  configureOctaveCatalog(async () => Response.json({tracks:[]}));
  assert.equal(await findRecording(wanted), undefined, 'The library must not substitute an unrelated artist');
  configureOctaveLibrary([]);
});
