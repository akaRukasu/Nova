import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmClipRecording, matchRecording } from '../dist/main/matcher.js';

const clip = { id: 'Tk9TM7-eTmw', title: 'Joseph', artist: 'Falling In Reverse', duration: 258, square: false };
const joseph = { id: 'octave:4283830192', title: 'Joseph', artist: 'Falling in Reverse', duration: 249, square: true };
const babyClip = { id: 'LiCDZYfAMdo', title: '...Baby One More Time', artist: 'First To Eleven', duration: 245, square: false };
const baby = { id: 'octave:3189424121', title: '...Baby One More Time', artist: 'First to Eleven', duration: 227, square: true };
const babySong = { ...babyClip, id: 'dFUFjrnykU0', duration: 228, square: true };

test('a short music-video intro does not hide the unambiguous official audio', () => {
  assert.equal(matchRecording(clip, [joseph]), joseph);
  assert.equal(matchRecording({ ...clip, artist: 'Luke Holland' }, [joseph]), undefined);
  assert.equal(matchRecording({ ...clip, title: 'Joseph (Live)' }, [joseph]), undefined);
  assert.equal(matchRecording(clip, [joseph, { ...joseph, id: 'octave:2' }]), undefined);
});

test('a long clip difference requires a matching audio release in both catalogues', () => {
  assert.equal(matchRecording(babyClip, [baby]), undefined);
  assert.equal(confirmClipRecording(babyClip, [baby], [babySong]), baby);
  assert.equal(confirmClipRecording(babyClip, [baby], [{ ...babySong, artist: 'Britney Spears' }]), undefined);
  assert.equal(confirmClipRecording(babyClip, [baby], [{ ...babySong, title: '...Baby One More Time (Instrumental)' }]), undefined);
  assert.equal(confirmClipRecording(babyClip, [baby, { ...baby, id: 'octave:2' }], [babySong]), undefined);
});
