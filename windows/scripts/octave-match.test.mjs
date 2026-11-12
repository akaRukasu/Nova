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

test('guest credits in the title and artist line identify the same recording in both directions', () => {
  const single = { id: 'octave:2074494067', title: 'Cross Off', artist: 'Mark Morton', album: 'Cross Off', duration: 253, square: true };
  const previous = { ...single, id: 'octave:played-old', artist: 'Mark Morton & Chester Bennington', duration: 249 };
  const youtube = { id: 'CDvegZR4ivI', title: 'Cross Off (avec Chester Bennington)', artist: 'Mark Morton', album: 'Anesthetic', duration: 254, square: true };
  assert.equal(matchRecording(previous, [youtube]), youtube);
  assert.equal(matchRecording(youtube, [single]), single);
  assert.equal(matchRecording(previous, [{ ...youtube, title: 'Cross Off (avec autre artiste)' }]), undefined);
  assert.equal(matchRecording(previous, [{ ...youtube, title: 'Cross Off (Live)' }]), undefined);
  assert.equal(matchRecording(previous, [{ ...youtube, duration: 310 }]), undefined);
});
