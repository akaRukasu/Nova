import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePopularTracks } from '../dist/main/popular.js';

test('the ranking alternates providers and links a matching video without dropping a live version', () => {
  const studio = { id: 'octave:42', title: 'One Track', artist: 'Artist', duration: 180, square: true };
  const video = { id: 'youtubetrack', title: 'Artist - One Track (Official Video)', artist: 'Artist', duration: 183, square: false };
  const live = { ...video, id: 'youtubelive1', title: 'One Track (Live)', duration: 240 };
  const octaveOnly = { ...studio, id: 'octave:44', title: 'Another Track' };
  const youtubeOnly = { ...live, id: 'youtubeonly', title: 'Only on YouTube' };
  const merged = mergePopularTracks([studio, octaveOnly], [video, live, youtubeOnly]);
  assert.deepEqual(merged.map(track => track.id), [studio.id, live.id, octaveOnly.id, youtubeOnly.id]);
  assert.equal(merged[0].youtubeId, video.id);
  assert.equal(studio.youtubeId, undefined);
  assert.deepEqual(mergePopularTracks([], [video, video]).map(track => track.id), [video.id]);
});
