import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer, createConnection } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NowPlaying } from '../dist/main/nowPlaying.js';
import { DiscordPresence } from '../dist/main/discordPresence.js';
import { publishedPlayback } from '../dist/main/publishedPlayback.js';

const song = { id: 'test-song', title: 'Un titre <live>', artist: 'Artiste QA', album: 'Album QA', duration: 200 };
const state = publishedPlayback({ track: song, playing: true, time: 36, duration: 200, queue: [{ title: 'Private' }] });
const delay = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    const result = await check();
    if (result) return result;
    await delay();
  }
  assert.fail('Expected state did not arrive');
}

test('OBS and read-only Cider clients receive playback on loopback and PlayingNow clears when stopped', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nova-playing-now-'));
  const live = new NowPlaying(directory, Buffer.from('<title>Nova</title>'), Buffer.from('cover'), async () => undefined);
  await live.start([0]);
  let socket;
  try {
    const url = live.origin;
    assert.ok(url?.startsWith('http://127.0.0.1:'));
    assert.equal((await fetch(url + '/api/v1/playback/active')).status, 204);
    assert.equal((await fetch(url + '/now-playing', { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(url + '/api/v1/playback/play', { method: 'POST' })).status, 405);
    assert.equal((await fetch(url + '/obs')).status, 200);
    live.publish(state);
    const { info } = await (await fetch(url + '/api/v1/playback/now-playing')).json();
    assert.equal(info.name, song.title);
    assert.equal(info.durationInMillis, 200000);
    assert.equal(info.isPlaying, true);
    const overlay = await (await fetch(url + '/now-playing')).json();
    assert.equal(overlay.position, 36);
    assert.ok(!('id' in overlay.track) && !('queue' in overlay));
    const exported = await waitFor(async () => {
      const content = await readFile(path.join(directory, 'song_info.json'), 'utf8').catch(() => 'None');
      return content !== 'None' && JSON.parse(content);
    });
    assert.equal(exported.title, 'Un titre &lt;live&gt;');
    assert.deepEqual(exported.artists, [song.artist]);

    const events = [];
    socket = new WebSocket(url.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
    socket.addEventListener('message', event => {
      if (event.data.startsWith('0')) socket.send('40');
      if (event.data === '2') socket.send('3');
      if (event.data.startsWith('42')) events.push(JSON.parse(event.data.slice(2)));
    });
    await waitFor(() => events.find(([channel, message]) => channel === 'API:Playback'
      && message.type === 'playbackStatus.nowPlayingItemDidChange' && message.data.name === song.title));
    live.publish({ ...state, playing: false });
    await waitFor(() => events.find(([channel, message]) => channel === 'API:Playback'
      && message.type === 'playbackStatus.playbackStateDidChange' && !message.data.isPlaying));
    assert.equal(await (await fetch(url + '/song_info.json')).text(), 'None');
  } finally {
    socket?.close();
    await live.stop();
    assert.equal(await readFile(path.join(directory, 'song_info.json'), 'utf8'), 'None');
    assert.ok(path.dirname(directory) === tmpdir() && path.basename(directory).startsWith('nova-playing-now-'));
    await rm(directory, { recursive: true, force: true });
  }
});

function rpcFrame(opcode, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(8);
  header.writeUInt32LE(opcode);
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data]);
}

test('Discord receives a listening activity on READY, then removes it on pause and disconnect', async () => {
  const messages = [];
  const server = createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const opcode = buffer.readUInt32LE(0), length = buffer.readUInt32LE(4);
        if (buffer.length < 8 + length) break;
        const message = JSON.parse(buffer.subarray(8, 8 + length));
        buffer = buffer.subarray(8 + length);
        messages.push(message);
        const reply = opcode === 0 ? { evt: 'READY' } : { nonce: message.nonce, cmd: message.cmd };
        socket.write(rpcFrame(1, reply));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new DiscordPresence(() => createConnection(server.address().port, '127.0.0.1'));
  try {
    client.publish(state);
    client.configure(true, '123456789012345678');
    await waitFor(() => client.status === 'active');
    assert.equal(messages[0].client_id, '123456789012345678');
    assert.equal(messages[1].args.activity.type, 2);
    assert.equal(messages[1].args.activity.details, song.title);
    assert.equal(messages[1].args.activity.state, song.artist);
    assert.equal(messages[1].args.activity.timestamps.end - messages[1].args.activity.timestamps.start, 200000);
    client.publish({ ...state, playing: false });
    await waitFor(() => client.status === 'ready');
    assert.equal(messages[2].args.activity, null);
  } finally {
    client.close();
    await new Promise(resolve => server.close(resolve));
  }
});
