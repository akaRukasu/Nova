import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalAudioLibrary } from '../dist/main/localAudio.js';

test('local WAV imports persist, deduplicate by bytes, and support seeking through byte ranges', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nova-local-audio-'));
  try {
    const bytes = Buffer.alloc(44 + 44100 * 2);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(88200, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
    const file = path.join(root, 'Artist - Title.wav');
    const invalid = path.join(root, 'invalid.txt');
    await writeFile(file, bytes); await writeFile(invalid, 'not audio');
    const library = new LocalAudioLibrary(() => path.join(root, 'Library'));
    const result = await library.import([file, file, invalid]);
    assert.equal(result.tracks.length, 1);
    assert.equal(result.errors.length, 1);
    const [track] = result.tracks;
    assert.equal(track.title, 'Title');
    assert.equal(track.artist, 'Artist');
    assert.equal(track.duration, 1);
    const restored = new LocalAudioLibrary(() => path.join(root, 'Library'));
    const response = await restored.response(track.id, 'bytes=100-199');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 100-199/' + bytes.length);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(100, 200));
    const suffix = await restored.response(track.id, 'bytes=-50');
    assert.equal((await suffix.arrayBuffer()).byteLength, 50);
    assert.equal((await restored.response(track.id, 'bytes=999999999-')).status, 416);
    assert.equal((await restored.response('local:../../file', null)).status, 400);
    assert.equal((await restored.response('local:' + '0'.repeat(64), null)).status, 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

