import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listeningHistory, mergeListeningHistory } from '../dist/shared/historySync.js';

const track = (id, title = id) => ({ id, title, artist: 'Artist', artwork: 'https://example.com/cover.jpg', square: true });
const state = (recents, dates = {}) => ({ recents, stats: Object.fromEntries(Object.entries(dates).map(([id,lastPlayed]) =>
  [id,{ playCount: 3, lastPlayed }])), settings: {}, playlists: [], liked: [], saved: [], searches: [] });

test('PC and phone converge, retain artwork, and repeated exchanges do not increment plays', () => {
  let pc = state([track('octave:1')], { 'octave:1': 200 });
  let phone = state([track('yt-2')], { 'yt-2': 300 });
  pc = mergeListeningHistory(pc, listeningHistory(phone));
  phone = mergeListeningHistory(phone, listeningHistory(pc));
  assert.deepEqual(listeningHistory(pc), listeningHistory(phone));
  assert.deepEqual(pc.recents.map(t=>t.id), ['yt-2','octave:1']);
  assert.equal(pc.recents[0].artwork,'https://example.com/cover.jpg');
  assert.deepEqual(listeningHistory(mergeListeningHistory(pc,listeningHistory(phone))),listeningHistory(pc));
  assert.equal(pc.stats['octave:1'].playCount,3);
});

test('removal and clear survive an offline device returning with old history', () => {
  const offline = state([track('octave:1')], { 'octave:1': 200 });
  const cleared = { ...state([]), historyChanges: {clearedAt:250} };
  const merged = mergeListeningHistory(cleared,listeningHistory(offline));
  assert.deepEqual(merged.recents,[]);
  const deleted = { ...state([]), historyChanges: {removed:{'octave:1':250}} };
  assert.deepEqual(mergeListeningHistory(deleted,listeningHistory(offline)).recents,[]);
  const replay = state([track('octave:1')],{'octave:1':300});
  assert.equal(mergeListeningHistory(deleted,listeningHistory(replay)).recents[0].id,'octave:1');
  assert.equal(mergeListeningHistory(merged,listeningHistory(replay)).recents[0].id,'octave:1');
});

test('a newer listen without artwork retains the cover from either device', () => {
  const older = state([track('octave:1')], { 'octave:1': 200 });
  const missing = { id: 'octave:1', title: 'Cross Off', artist: 'Mark Morton', square: true };
  const newer = state([missing], { 'octave:1': 300 });
  const forward = mergeListeningHistory(older, listeningHistory(newer));
  const backward = mergeListeningHistory(newer, listeningHistory(older));
  assert.equal(forward.recents[0].artwork, 'https://example.com/cover.jpg');
  assert.deepEqual(listeningHistory(forward), listeningHistory(backward));
  assert.equal(forward.recents[0].title, 'Cross Off');
});
