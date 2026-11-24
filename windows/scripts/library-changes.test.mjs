import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLibraryRemovals, mergeLibraryChanges, restoreLibraryTracks } from '../dist/shared/libraryChanges.js';
import { portableBackup } from '../dist/shared/portableBackup.js';

const song = { id: 'octave:42', youtubeId: 'yt42', title: 'Titre', artist: 'Artiste' };
const alias = { ...song, id: 'yt42', youtubeId: undefined };
const state = () => ({ added: [song], liked: [song], playlists: [{ id: 'p', name: 'QA', tracks: [song, alias] }],
  saved: [], searches: [], recents: [song], stats: {}, settings: {} });

test('library removal filters every origin, including a linked YouTube reference, while retaining listening history', () => {
  const removed = applyLibraryRemovals({ ...state(), libraryChanges: { removed: { [song.id]: 1000, yt42: 1000 } } });
  assert.equal(removed.added.length + removed.liked.length + removed.playlists[0].tracks.length, 0);
  assert.equal(removed.recents.length, 1);
  const stale = { ...removed, ...state(), libraryChanges: removed.libraryChanges };
  assert.equal(applyLibraryRemovals(stale).playlists[0].tracks.length, 0);
});

test('removal and deliberate re-addition converge in either sync order and survive the mobile backup format', () => {
  const a = { removed: { [song.id]: 1000 }, restored: { [song.id]: 500 } };
  const b = { removed: { [song.id]: 800 }, restored: { [song.id]: 1100 } };
  const merged = mergeLibraryChanges(a, b.removed, b.restored);
  assert.deepEqual(merged, mergeLibraryChanges(b, a.removed, a.restored));
  assert.equal(applyLibraryRemovals({ ...state(), libraryChanges: merged }).liked.length, 1);
  const readded = restoreLibraryTracks({ ...state(), libraryChanges: a }, [song], 2000);
  assert.equal(applyLibraryRemovals(readded).added.length, 1);
  const backup = portableBackup(readded);
  assert.deepEqual(backup.library.libraryRemoved, a.removed);
  assert.equal(backup.library.libraryRestored[song.id], 2000);
});
