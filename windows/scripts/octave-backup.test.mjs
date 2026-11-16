import test from 'node:test';
import assert from 'node:assert/strict';
import { octaveBackupLibrary } from '../dist/shared/octaveBackup.js';

test('Octave v2 backups collapse duplicate imports while preserving the exact release and creation date', () => {
  const album = { id: '91', title: 'An Album', cover_big: 'https://example.com/cover.jpg' };
  const track = { id: '42', title: 'Name', artist: { id: 22, name: 'Artist' }, album, duration: 180 };
  const live = { ...track, id: '430', title: 'Name (Live)', duration: 241 };
  const backup = { app: 'octave', type: 'library-backup', version: 2, data: { 'octave:library': { state: {
    playlists: [
      { id: 'liked', name: 'Liked Songs', tracks: [track, track] },
      { id: 'import1', name: 'Library Songs', tracks: [track], createdAt: 1794000000000 },
      { id: 'import2', name: ' library songs ', tracks: [track, live], createdAt: 1794100000000 },
    ], savedAlbums: [album],
  } }, 'octave:settings': { quality: 'lossless' } } };
  const result = octaveBackupLibrary(backup);
  assert.equal(result.liked.length, 1);
  assert.equal(result.playlists.length, 1);
  assert.equal(result.playlists[0].created, 1794000000000);
  assert.deepEqual(result.playlists[0].tracks.map(item => item.id), ['octave:42', 'octave:430']);
  assert.equal(result.liked[0].albumId, 'octave:91');
  assert.equal(result.liked[0].artistId, 'octave:22');
  assert.deepEqual(Object.keys(result).sort(), ['liked', 'playlists', 'saved']);
  assert.throws(() => octaveBackupLibrary({ library: {} }), /sauvegarde/);
});
