const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

test('the tested webcam can replace a stale Discord choice without retargeting tests, mic or desktop capture', async () => {
  const calls = [], saved = new Map();
  class Track {
    kind = 'video'; readyState = 'live'; enabled = true; muted = false;
    constructor(id) { this.id = id; this.label = id === 'webcam' ? 'Working webcam' : 'USB capture'; }
    getSettings() { return { deviceId: this.id, width: 640, height: 480, frameRate: 30 }; }
    clone() { return new Track(this.id); }
    stop() { this.readyState = "ended"; }
  }
  const storage = { getItem: key => saved.get(key), setItem: (key,value) => saved.set(key,value) };
  const native = async options => {
    calls.push(options);
    const id = options.video?.deviceId?.exact || 'capture';
    if (id === 'missing') throw Object.assign(new Error('Disconnected'), { name: 'NotFoundError' });
    if (options.video?.width?.exact === 99999) throw Object.assign(new Error('Format'), { name: 'OverconstrainedError', constraint: 'width' });
    const track = new Track(id);
    return { getVideoTracks: () => options.video ? [track] : [], getAudioTracks: () => [] };
  };
  const navigator = { mediaDevices: { getUserMedia: native, enumerateDevices: async () => [
    { kind: 'videoinput', deviceId: 'webcam', label: 'Working webcam' },
    { kind: 'videoinput', deviceId: 'capture', label: 'USB capture' },
  ] } };
  const window = { localStorage: storage, MediaStreamTrack: Track }; window.top = window;
  vm.runInNewContext(readFileSync('mod/media.js', 'utf8'), { window, navigator, location: { hostname: 'discord.com' }, console });
  delete window.localStorage;
  await window.NovaCordMedia.selectCamera('webcam');
  const microphone = { echoCancellation: true };
  const request = { audio: microphone, video: { deviceId: { exact: 'capture' }, width: { exact: 99999 } } };
  const stream = await navigator.mediaDevices.getUserMedia(request);
  assert.equal(stream.getVideoTracks()[0].label, 'Working webcam');
  assert.equal(calls[0].audio, microphone);
  assert.equal(calls[0].video.deviceId.exact, 'webcam');
  assert.equal(calls[1].video.deviceId.exact, 'webcam');
  assert.equal(calls[1].video.width, undefined);
  assert.equal(request.video.deviceId.exact, 'capture', 'Do not mutate the caller constraints');
  stream.getVideoTracks()[0].clone();
  const preview = await window.NovaCordMedia.testCamera('capture');
  assert.equal(calls.at(-1).video.deviceId.exact, 'capture', 'Testing another device must ignore the call preference');
  const info = await window.NovaCordMedia.diagnostics();
  assert.equal(info.cameras.filter(camera => camera.role === 'discord' && camera.matchesRequestedDevice).length, 2);
  assert.ok(info.cameras.some(camera => camera.role === 'test' && camera.name === 'USB capture'));
  await navigator.mediaDevices.getUserMedia({ audio: microphone, video: false });
  assert.equal(calls.at(-1).video, false);
  const desktop = { mandatory: { chromeMediaSource: 'desktop' } };
  await navigator.mediaDevices.getUserMedia({ video: desktop });
  assert.equal(calls.at(-1).video, desktop);
  await assert.rejects(window.NovaCordMedia.selectCamera('missing'), /plus disponible/);
  await window.NovaCordMedia.selectCamera('');
  await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: 'capture' } } });
  assert.equal(calls.at(-1).video.deviceId.exact, 'capture');
  assert.equal(window.NovaCordMedia.cameraChoice(), null);
  assert.equal(preview.getVideoTracks()[0].readyState, 'ended', 'Call capture releases the camera test');
});
