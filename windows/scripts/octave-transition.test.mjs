import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../../Nova/Resources/nova-octave-transition.js', import.meta.url), 'utf8');

function player({ mixes = false, openAt = 174, seamEnd = 175, automatic = true } = {}) {
  let expanded = false;
  let opens = 0;
  let crossfades = 0;
  const menuButton = {
    getClientRects: () => [1],
    getAttribute: () => String(expanded),
    click() { expanded = !expanded; if (expanded) opens++; },
  };
  const option = (title, text, click = () => {}) => ({ textContent: text, querySelector: selector => ({ textContent: selector.includes('+') ? text.slice(title.length) : title }), click });
  const menu = { textContent: 'Next Transition', parentElement: { querySelectorAll: () => [
    option('Automatic', automatic ? 'AutomaticGapless Join✓' : 'AutomaticGapless Join'),
    option('Crossfade', 'Crossfade6 s', () => { crossfades++; expanded = false; }),
  ] } };
  const document = { querySelectorAll: selector => selector === 'p' ? (expanded ? [menu] : []) : [menuButton] };
  const window = { __octaveAutomix: { preview: { trackId: '1', mixes, openAt, seamEnd } } };
  runInNewContext(script, { window, document, location: { origin: 'https://music.octavestreaming.com' } });
  return { poll: window.novaOctaveTransition, counts: () => ({ opens, crossfades }) };
}

test('a short Octave join gets one native crossfade for the upcoming pair', () => {
  const { poll, counts } = player();
  poll('1', 130, 'first'); // Too early to override a provisional plan.
  assert.deepEqual(counts(), { opens: 0, crossfades: 0 });
  poll('1', 149, 'first');
  poll('1', 150, 'first');
  poll('1', 152, 'first');
  assert.deepEqual(counts(), { opens: 1, crossfades: 1 });
  poll('1', 153, 'updated');
  poll('1', 154, 'updated');
  assert.deepEqual(counts(), { opens: 2, crossfades: 2 });
});

test('a full Apple-style blend, late sampling, and a stale track ID are left alone', () => {
  const blend = player({ mixes: true, openAt: 165 });
  blend.poll('1', 145);
  const join = player();
  join.poll('1', 170);
  join.poll('2', 145);
  assert.deepEqual(blend.counts(), { opens: 0, crossfades: 0 });
  assert.deepEqual(join.counts(), { opens: 0, crossfades: 0 });
});

test('a user-selected transition is preserved', () => {
  const { poll, counts } = player({ automatic: false });
  poll('1', 150);
  poll('1', 151);
  assert.deepEqual(counts(), { opens: 1, crossfades: 0 });
});
