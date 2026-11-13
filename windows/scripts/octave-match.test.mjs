import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmClipRecording, matchRecording, recordingSearchQueries } from '../dist/main/matcher.js';
import { sizedArtwork } from '../dist/shared/artwork.js';

const clip = { id: 'Tk9TM7-eTmw', title: 'Joseph', artist: 'Falling In Reverse', duration: 258, square: false };
const joseph = { id: 'octave:4283830192', title: 'Joseph', artist: 'Falling in Reverse', duration: 249, square: true };
const babyClip = { id: 'LiCDZYfAMdo', title: '...Baby One More Time', artist: 'First To Eleven', duration: 245, square: false };
const baby = { id: 'octave:3189424121', title: '...Baby One More Time', artist: 'First to Eleven', duration: 227, square: true };
const babySong = { ...babyClip, id: 'dFUFjrnykU0', duration: 228, square: true };

test('Official Audio identifies the studio track without accepting live edits or covers', () => {
  const wanted = { id: 'video', title: 'Deer Dance (Official Audio)', artist: 'System Of A Down', duration: 177 };
  const recording = { id: 'octave:42', title: 'Deer Dance', artist: 'System of a Down', album: 'Toxicity', duration: 175 };
  assert.equal(matchRecording(wanted, [recording]), recording);
  assert.equal(matchRecording(wanted, [{ ...recording, title: 'Deer Dance (Live)' }]), undefined);
  assert.equal(matchRecording(wanted, [{ ...recording, artist: 'Vitamin String Quartet' }]), undefined);
});

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

test('a saved autoplay entry can recover its exact edition when the old duration was wrong', () => {
  const saved = { id: 'octave:played-old', title: 'Old School Hollywood', artist: 'System of A Down',
    album: 'Mezmerize', duration: 220, square: true };
  const studio = { ...saved, id: 'octave:559726', duration: 177 };
  const live = { ...studio, title: 'Old School Hollywood (Live)' };
  assert.equal(matchRecording(saved, [live, studio]), studio);
  assert.equal(matchRecording(saved, [{ ...studio, album: 'Another Release' }]), undefined);
  assert.equal(matchRecording(saved, [{ ...studio, artist: 'Vitamin String Quartet' }]), undefined);
  assert.equal(matchRecording({ ...saved, id: 'Mi5oHdNAa4Q' }, [studio]), undefined);
});

test('old Octave covers request the native image size for each surface', () => {
  const cover = 'https://e-cdns-images.dzcdn.net/images/cover/art/56x56-000000-80-0-0.jpg';
  assert.equal(sizedArtwork(cover, 176), cover.replace('/56x56-', '/250x250-'));
  assert.equal(sizedArtwork(cover, 780), cover.replace('/56x56-', '/1000x1000-'));
  assert.equal(sizedArtwork(cover.replace('dzcdn.net', 'other.example'), 780), cover.replace('dzcdn.net', 'other.example'));
});

test('YouTube artist ordering and a square clip cover do not hide Joseph', () => {
  const reordered = { ...clip, artist: 'Serj Tankian, Corey Taylor et Falling In Reverse', square: true };
  const song = { ...clip, id: 'lKVZKG7CcMU', artist: 'Falling In Reverse, Corey Taylor et Serj Tankian',
    duration: 250, square: true, album: 'Joseph' };
  assert.equal(matchRecording(song, [joseph]), joseph);
  assert.equal(confirmClipRecording(reordered, [joseph], [song]), joseph);
  assert.equal(confirmClipRecording({ ...reordered, artist: 'Luke Holland' }, [joseph], [song]), undefined);
});

test('a quoted music-video title with the credited artist prefix resolves through its audio release', () => {
  const clip = { id: '-S0aea777jM',
    title: 'Tee Grizzley - "From The D To The A ft. Lil Yachty" [Official Video]',
    artist: 'Tee Grizzley', duration: 170 };
  const audio = { id: 'QFp7phPYUvQ', title: 'From The D To The A (avec Lil Yachty)',
    artist: 'Tee Grizzley', duration: 159, square: true };
  const octave = { id: 'octave:144393532', title: 'From The D To The A (feat. Lil Yachty)',
    artist: 'Tee Grizzley', album: 'From The D To The A (feat. Lil Yachty)', duration: 158, square: true };
  assert(recordingSearchQueries(clip).includes('From The D To The A ft. Lil Yachty Tee Grizzley'));
  assert.equal(matchRecording(clip, [octave]), undefined);
  assert.equal(confirmClipRecording(clip, [octave], [audio]), octave);
  assert.equal(confirmClipRecording(clip, [{ ...octave, artist: 'City Girls' }], [audio]), undefined);
  assert.equal(confirmClipRecording(clip, [{ ...octave, title: octave.title + ' (Live)' }], [audio]), undefined);
  assert.equal(confirmClipRecording(clip, [octave], [{ ...audio, title: 'From The D To The A (avec Lil Wayne)' }]), undefined);
  assert.equal(confirmClipRecording({ ...clip, title: clip.title.replace('Tee Grizzley -', 'Other Artist -') }, [octave], [audio]), undefined);
  assert.equal(matchRecording({ ...clip, duration: 159 }, [octave]), octave);
});

test('video labels and the credited artist at either end retain the recording and its edition', () => {
  const song = { id: 'octave:1', title: 'Example', artist: 'Known Artist', duration: 190, square: true };
  for (const title of ['Known Artist - Example (Audio)', 'Example - Known Artist [Lyrics]',
    'Known Artist | “Example” [Official Visualizer]', 'Example (Official Explicit Audio)']) {
    assert.equal(matchRecording({ ...song, id: 'youtube', title }, [song]), song);
    assert.equal(matchRecording({ ...song, id: 'youtube', title: title.replace('Example', 'Example (Live)') }, [song]), undefined);
  }
  const guest = { ...song, title: 'Example (feat. Guest)' };
  assert.equal(matchRecording({ ...song, title: 'Known Artist - Example (Audio) ft. Guest' }, [guest]), guest);
  assert.equal(matchRecording({ ...song, title: 'Example - Unknown Artist [Lyrics]' }, [song]), undefined);
});

test('an EP title annotation requires confirmation from the official audio listing', () => {
  const clip = { id: 'RUG55VN7SAI', title: 'Step Up - Linkin Park', artist: 'Linkin Park', duration: 237, square: false };
  const octave = { id: 'octave:1100610192', title: 'Step Up (Hybrid Theory EP)', artist: 'Linkin Park',
    album: 'Hybrid Theory (20th Anniversary Edition)', duration: 234, square: true };
  const audio = { ...octave, id: 'J8CUHhg1DhU', duration: 235 };
  assert.equal(matchRecording(clip, [octave]), undefined);
  assert.equal(confirmClipRecording(clip, [octave], []), undefined);
  assert.equal(confirmClipRecording(clip, [octave], [audio]), octave);
  assert.equal(confirmClipRecording(clip, [{ ...octave, title: 'Step Up (Live EP)' }], [{ ...audio, title: 'Step Up (Live EP)' }]), undefined);
  assert.equal(confirmClipRecording(clip, [{ ...octave, album: 'Another release' }], [audio]), undefined);
});

test('a nine-second clip intro accepts one studio recording with the same title and artist', () => {
  const clip = { id: 'pJbysSbUg74', title: 'LVZ - Brisé (CLIP OFFICIEL)', artist: 'LVZ', duration: 189, square: false };
  const audio = { id: 'octave:1231490422', title: 'Brisé', artist: 'LVZ', duration: 180, square: true };
  assert.equal(matchRecording(clip, [audio]), audio);
  assert.equal(matchRecording(clip, [audio, { ...audio, id: 'octave:2' }]), undefined);
  assert.equal(matchRecording({ ...clip, artist: 'Other Artist' }, [audio]), undefined);
});

test('an abbreviated final word needs the same artist, close duration and a confirmed full audio title', () => {
  const clip = { id: 'TmQ5erMKsQU', title: 'DA Uzi - Vrai N (Clip officiel)', artist: 'DA Uzi', duration: 120 };
  const octave = { id: 'octave:4359983131', title: 'Vrai négro', artist: 'DA Uzi', duration: 121, square: true };
  const audio = { ...octave, id: 'QOdQvWjOT-4', duration: 122 };
  assert.equal(matchRecording(clip, [octave]), undefined);
  assert.equal(confirmClipRecording(clip, [octave], []), undefined);
  assert.equal(confirmClipRecording(clip, [octave], [audio]), octave);
  assert.equal(confirmClipRecording(clip, [{ ...octave, duration: 180 }], [audio]), undefined);
  assert.equal(confirmClipRecording(clip, [{ ...octave, artist: 'Other Artist' }], [audio]), undefined);
  assert.equal(confirmClipRecording(clip, [{ ...octave, title: 'Vrai négro (Remix)' }], [{ ...audio, title: 'Vrai négro (Remix)' }]), undefined);
});
