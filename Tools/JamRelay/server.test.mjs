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
