import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createJamRelay } from './server.mjs';

test('two clients discover, join and share a Jam through a private relay', async t => {
  const key = randomBytes(24).toString('hex');
  const server = createJamRelay(key);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/nova-jam';
  async function send(body, secret = key) {
    const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify(body),
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' } });
    return [response.status, await response.json()];
  }

  assert.equal((await send({ action: 'list' }, 'incorrect'))[0], 401);
  const [status, host] = await send({ action: 'host', name: 'Alex' });
  assert.equal(status, 200);
  assert.deepEqual((await send({ action: 'list' }))[1].rooms, [{ id: host.id, name: 'Alex', people: 1 }]);
  const [, guest] = await send({ action: 'join', room: host.id, name: 'Camille' });
  assert.equal((await send({ action: 'poll', room: host.id, token: 'bad' }))[0], 403);

  const track = { id: 'octave:1', title: 'Titre', artist: 'Artiste' };
  const state = { queue: [track], playing: true, position: 37, sentAt: Date.now(), index: 0, guestsCanControl: true, addedBy: {} };
  assert.equal((await send({ action: 'send', room: host.id, token: host.token, state }))[0], 200);
  const [, update] = await send({ action: 'poll', room: host.id, token: guest.token, after: 0 });
  assert.deepEqual(update.state.queue, [track]);
  assert.deepEqual(update.state.participants, ['Camille']);
  assert.equal(update.state.position, 37);
  assert.equal((await send({ action: 'poll', room: host.id, token: guest.token, after: update.version }))[1].state, undefined);

  assert.equal((await send({ action: 'send', room: host.id, token: guest.token, event: { type: 'command', command: 'next' } }))[0], 200);
  const [, events] = await send({ action: 'poll', room: host.id, token: host.token, after: 0 });
  assert.deepEqual(events.events, [{ seq: 1, name: 'Camille', event: { type: 'command', command: 'next' } }]);
  assert.deepEqual((await send({ action: 'poll', room: host.id, token: host.token, after: 1 }))[1].events, []);
  await send({ action: 'leave', room: host.id, token: host.token });
  assert.equal((await send({ action: 'poll', room: host.id, token: guest.token, after: 0 }))[0], 404);
});

test('a new device can host without setup while only its session owner can end the room', async t => {
  const key = randomBytes(24).toString('hex');
  const server = createJamRelay(key, undefined, { publicHosting: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/nova-jam';
  async function send(action, fields = {}, bearer) {
    const response = await fetch(endpoint, {
      method: 'POST', body: JSON.stringify({ action, ...fields }),
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
    });
    return [response.status, await response.json()];
  }
  assert.equal((await send('list'))[0], 401);
  const [created, host] = await send('host', { name: 'Nouvel appareil' });
  assert.equal(created, 200);
  assert.notEqual(host.invite, host.token);
  assert.deepEqual((await send('list', {}, key))[1].rooms, []);
  const room = host.id;
  assert.equal((await send('join', { room }))[0], 401);
  assert.equal((await send('join', { room }, key))[0], 403);
  const [joined, guest] = await send('join', { room, name: 'Invité' }, host.invite);
  assert.equal(joined, 200);
  const state = { queue: [], index: 0, position: 0, playing: false, sentAt: Date.now() };
  assert.equal((await send('send', { room, token: host.token, state }, host.token))[0], 200);
  assert.equal((await send('poll', { room, token: guest.token, after: 0 }, host.invite))[1].state.hostName, 'Nouvel appareil');
  assert.equal((await send('leave', { room, token: host.token }, host.invite))[0], 403);
  assert.equal((await send('leave', { room, token: host.token }, host.token))[0], 200);
  assert.equal((await send('poll', { room, token: guest.token, after: 0 }, host.invite))[0], 404);
  for (let i = 0; i < 4; i++) assert.equal((await send('host'))[0], 200);
  assert.equal((await send('host'))[0], 429);
});

test('an invitation grants guest access to one room and expires when the host ends it', async t => {
  const key = randomBytes(24).toString('hex');
  const track = { id: 'octave:15523772', title: 'Deer Dance', artist: 'System Of A Down' };
  const server = createJamRelay(key, async query => {
    assert.equal(query, 'Deer Dance');
    return [track];
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/nova-jam';
  async function send(action, secret, fields = {}) {
    const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ action, ...fields }),
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' } });
    return [response.status, await response.json()];
  }
  assert.equal((await fetch(endpoint + '/app/')).status, 200);
  assert.equal((await fetch(endpoint + '/app/manifest.webmanifest')).status, 200);
  const [, host] = await send('host', key, { name: 'Hôte' });
  const [, other] = await send('host', key, { name: 'Autre' });
  assert.notEqual(host.invite, key);
  assert.equal((await send('list', host.invite))[0], 401);
  assert.equal((await send('host', host.invite))[0], 401);
  assert.equal((await send('join', host.invite, { room: other.id }))[0], 403);
  const room = host.id;
  const [, guest] = await send('join', host.invite, { room, name: 'Invité Web' });
  assert.deepEqual(await send('search', host.invite, { room, token: guest.token, query: 'Deer Dance' }), [200, { tracks: [track] }]);
  assert.equal((await send('leave', host.invite, { room, token: host.token }))[0], 403);
  assert.equal((await send('send', host.invite, { room, token: guest.token, event: { type: 'add', track } }))[0], 200);
  const [, polled] = await send('poll', key, { room, token: host.token });
  assert.deepEqual(polled.events[0].event.track, track);
  assert.equal((await send('leave', host.invite, { room, token: guest.token }))[0], 200);
  assert.equal((await send('poll', host.invite, { room, token: guest.token }))[0], 403);
  assert.equal((await send('leave', key, { room, token: host.token }))[0], 200);
  assert.equal((await send('join', host.invite, { room }))[0], 404);
});
