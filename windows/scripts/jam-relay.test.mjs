import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultJamRelay, jamRelay, parseJamCircle, parseJamInvitation, requireHostInvitation } from '../src/renderer/lib/jamRelay.ts';
const hostKey = 'a'.repeat(48);
const guestKey = 'b'.repeat(48);
const room = '1'.repeat(16);
const circle = parseJamCircle(`https://example.test/nova-jam/#${hostKey}`);

test('the trailing slash reaches the canonical endpoint and the host must receive a room invite', () => {
  assert.equal(circle.endpoint, 'https://example.test/nova-jam');
  assert.throws(() => requireHostInvitation(circle, room), /pas fourni d’invitation/);
  assert.throws(() => requireHostInvitation(circle, room, 'invalid'), /pas fourni d’invitation/);
  const invitation = requireHostInvitation(circle, room, guestKey);
  assert.deepEqual(parseJamInvitation(invitation), { id: room, circle: { endpoint: circle.endpoint, key: guestKey } });
  assert(!invitation.includes(hostKey));
});

test('the default Android relay starts hosting without a configuration credential', async t => {
  t.after(() => { delete globalThis.window; });
  globalThis.window = { nova: {
    platform: 'android',
    async invoke(channel, relay, body) {
      assert.equal(channel, 'jam:relay');
      assert.equal(relay.key, undefined);
      assert.equal(body.action, 'host');
      return { status: 200, data: { id: room, token: 'session', invite: guestKey } };
    },
  } };
  const result = await jamRelay(defaultJamRelay, { action: 'host' });
  assert.equal(requireHostInvitation(defaultJamRelay, result.id, result.invite), defaultJamRelay.endpoint + '/app/#' + room + '.' + guestKey);
});

test('Android uses the native network bridge and reports non-JSON proxy errors', async t => {
  t.after(() => { delete globalThis.window; });
  let reply = { status: 200, data: { id: room, token: 'session', invite: guestKey } };
  globalThis.window = { nova: {
    platform: 'android',
    async invoke(channel, forwardedCircle, body) {
      assert.equal(channel, 'jam:relay');
      assert.equal(forwardedCircle.endpoint, circle.endpoint);
      assert.deepEqual(body, { action: 'host' });
      return reply;
    },
  } };
  const result = await jamRelay(circle, { action: 'host' });
  assert.equal(result.invite, guestKey);
  reply = { status: 401, data: '<html>Authorization required</html>' };
  await assert.rejects(jamRelay(circle, { action: 'host' }), { status: 401, message: /configuration hôte/ });
});
