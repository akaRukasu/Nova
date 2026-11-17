import assert from 'node:assert/strict';
import test from 'node:test';
import { localPlaybackSelector } from '../dist/shared/localPlayback.js';

test('the YouTube copies in the two reported cases use the corresponding imported files', () => {
  const local = [
    { id: 'local:a', title: 'e-dubble - Hampden Parks (Freestyle Friday #7)', artist: 'e-dubble', duration: 150.125 },
    { id: 'local:b', title: 'Yung Mavu - BLACK MAGIC ( Black Harry Potter )', artist: 'Yung Mavu', duration: 157.805 },
  ];
  const pick = localPlaybackSelector(local, new Set(local.map(track => track.id)));
  assert.equal(pick({ ...local[0], id: '1FPMF-yq8NQ', artist: 'E-Dubble', duration: 166 }), local[0]);
  assert.equal(pick({ ...local[1], id: 'MvjQTA81MhY', duration: 158 }), local[1]);
  const edit = { ...local[1], id: 'octave:357785041', title: 'Black Magic (Trap Edit)', duration: 187 };
  assert.equal(pick(edit), edit);
  const missing = { ...local[1], id: 'MvjQTA81MhY', duration: 158 };
  assert.equal(localPlaybackSelector(local, new Set())(missing), missing);
  const alternate = { ...local[1], id: 'local:c', duration: 159 };
  assert.equal(localPlaybackSelector([...local, alternate], new Set(['local:b', 'local:c']))(missing), missing);
});
