import test from 'node:test';
import assert from 'node:assert/strict';
import { localContinuation } from '../dist/shared/localContinuation.js';

test('local autoplay prioritizes the album and artist, excludes queued aliases and limits suggestions', () => {
  const seed = { id:'local:a', title:'Un', artist:'Artiste', album:'Album' };
  const library = [
    { id:'other', title:'Autre', artist:'Autre' },
    seed,
    { id:'local:c', title:'Trois', artist:'Autre' },
    { id:'octave:b', youtubeId:'ytb', title:'Deux', artist:'Artiste', album:'Album' },
    { id:'same-artist', title:'Quatre', artist:'Artiste' },
    { id:'ytb', title:'Deux', artist:'Artiste', album:'Album' },
  ];
  const result=localContinuation(seed,library,[seed]);
  assert.deepEqual(result.map(t=>t.id),['octave:b','same-artist','local:c','other']);
  assert.equal(localContinuation(seed,library,[seed],2).length,2);
  assert.deepEqual(localContinuation(seed,[seed],[seed]),[]);
  assert.ok(!localContinuation(seed,library,[seed,library[3]]).some(t=>t.id==='ytb'));
});
