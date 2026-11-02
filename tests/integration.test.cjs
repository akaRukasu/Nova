const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const bootstrap = readFileSync("mod/vencord-bootstrap.js", "utf8");
const mixer = readFileSync("mod/soundboard.js", "utf8");
const mediaScript = readFileSync("mod/media.js", "utf8");

test("Vencord stream defaults preserve user choices", () => {
  let saved = JSON.stringify({ plugins: { FakeNitro: { enabled: false }, WebScreenShare: { resolution: "1440" } } });
  vm.runInNewContext(bootstrap, { localStorage: { getItem: () => saved, setItem: (_, value) => { saved = value; } }, console });
  const settings = JSON.parse(saved);
  assert.equal(settings.plugins.FakeNitro.enabled, false);
  assert.equal(settings.plugins.FakeNitro.enableStreamQualityBypass, true);
  assert.equal(settings.plugins.WebScreenShare.resolution, "1440");
  assert.equal(settings.plugins.WebScreenShare.frameRate, "60");
});

function setupMixer(t, enabled = false) {
  let muted = false;
  let fetchSound = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
  const sources = [];
  const changes = [];
  const track = (kind = "audio") => ({ kind, enabled: true, readyState: "live", stop() { this.readyState = "ended"; } });
  const input = track();
  const video = track("video");
  const sender = { track: input };
  const videoSender = { track: video };
  let onSender;
  class Stream { constructor(tracks) { this.tracks = tracks; } getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); } }
  class Context {
    constructor() { this.state = "suspended"; this.destination = {}; }
    resume() { this.state = "running"; return Promise.resolve(); }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createMediaStreamDestination() { return { stream: new Stream([track()]) }; }
    async decodeAudioData() { return {}; }
    createBufferSource() {
      const source = { started: false, stopped: false, connect(target) { this.target = target; }, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; this.onended?.(); } };
      sources.push(source);
      return source;
    }
  }
  const nativeCapture = async () => new Stream([input, video]);
  const navigator = { mediaDevices: { getUserMedia: nativeCapture } };
  const window = { localStorage: { getItem: () => String(enabled), setItem() {} },
    NovaCordMedia: { senders: () => [sender, videoSender], onSender(callback) { onSender = callback; callback(sender); callback(videoSender); },
      async replaceTrack(sender, track) { sender.track = track; } },
    Vencord: { Webpack: { Common: { MediaEngineStore: { isSelfMute: () => muted, isSelfDeaf: () => false, addChangeListener: (fn) => changes.push(fn) } } } } };
  window.top = window;
  vm.runInNewContext(mixer, { window, navigator, MediaStream: Stream, AudioContext: Context,
    location: { hostname: "discord.com" }, console, setTimeout, clearTimeout, setInterval, clearInterval,
    indexedDB: { open: () => ({}) }, fetch: (...args) => fetchSound(...args) });
  t.after(() => window.NovaCordAudio.setEnabled(false));
  return { audio: window.NovaCordAudio, sender, input, video, videoSender, sources, navigator, nativeCapture,
    mute: () => { muted = true; changes.forEach((fn) => fn()); },
    setFetch: (fn) => { fetchSound = fn; },
    replace: async (next) => { sender.track = next; onSender(sender); await window.NovaCordAudio.setEnabled(true); },
    newTrack: track,
  };
}

test("activation after joining wires the actual sender and leaves camera/capture untouched", async (t) => {
  const env = setupMixer(t);
  assert.equal(env.sender.track, env.input);
  assert.equal(env.navigator.mediaDevices.getUserMedia, env.nativeCapture);
  await env.audio.setEnabled(true);
  assert.notEqual(env.sender.track, env.input);
  assert.equal(env.videoSender.track, env.video);
  await env.audio.play("discord:1234");
  assert.equal(env.sources[0].started, true);
  env.mute();
  assert.equal(env.sender.track.enabled, false);
  assert.equal(env.sources[0].stopped, true);
  await assert.rejects(env.audio.play("discord:1234"), /coupé/);
  await env.audio.setEnabled(false);
  assert.equal(env.sender.track, env.input);
  assert.equal(env.input.enabled, false, "Désactiver le mixeur ne doit pas réactiver un micro coupé");
  assert.equal(env.input.readyState, "live");
  assert.equal(env.video.readyState, "live");
});

test("microphone replacement reconnects the mixer and disabling restores the new input", async (t) => {
  const env = setupMixer(t);
  await env.audio.setEnabled(true);
  const next = env.newTrack();
  await env.replace(next);
  assert.notEqual(env.sender.track, next);
  await env.audio.setEnabled(false);
  assert.equal(env.sender.track, next);
  assert.equal(env.input.readyState, "live");
});

test("stop cancels a sound still downloading", async (t) => {
  const env = setupMixer(t);
  await env.audio.setEnabled(true);
  let finishDownload, started;
  const downloadStarted = new Promise((resolve) => { started = resolve; });
  env.setFetch(() => new Promise((resolve) => { finishDownload = resolve; started(); }));
  const pending = env.audio.play("discord:1234");
  await downloadStarted;
  env.audio.stopAll();
  finishDownload({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
  await pending;
  assert.equal(env.sources.length, 0);
});

test("a disabled mixer refuses transmission but allows explicit local preview", async (t) => {
  const env = setupMixer(t);
  await assert.rejects(env.audio.play("discord:1234"), /Active la soundboard/);
  await env.audio.preview("discord:1234");
  assert.equal(env.sources[0].started, true);
  assert.equal(env.sender.track, env.input);
});

test("camera format fallback retains the chosen device and returns the original stream", async () => {
  const calls = [];
  const raw = { untouched: true };
  const window = { localStorage: { getItem: () => null } };
  window.top = window;
  const navigator = { mediaDevices: { async getUserMedia(options) {
    calls.push(options);
    if (calls.length === 1) throw Object.assign(new Error("unsupported format"), { name: "OverconstrainedError", constraint: "width" });
    return raw;
  } } };
  vm.runInNewContext(mediaScript, { window, navigator, location: { hostname: "discord.com" }, console });
  const result = await navigator.mediaDevices.getUserMedia({ audio: true, video: { deviceId: { exact: "chosen-camera" }, width: { exact: 99999 } } });
  assert.equal(result, raw);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].video.deviceId.exact, "chosen-camera");
  assert.equal(calls[1].video.width, undefined);
  assert.equal(calls[1].audio, true);
});

test("stream configuration uses the chosen profile instead of fixed 4K/120", () => {
  const window = { Vencord: { Settings: { plugins: { WebScreenShare: { resolution: "720", frameRate: "30" } } } } };
  window.top = window;
  vm.runInNewContext(mediaScript, { window, navigator: {}, location: { hostname: "discord.com" }, console });
  const options = window.NovaCordMedia.configureStreamOptions({ capture: { height: 2160, framerate: 120 }, encode: { height: 2160 } });
  assert.equal(options.capture.height, 720);
  assert.equal(options.encode.height, 720);
  assert.equal(options.capture.framerate, 30);
  assert.ok(options.bitrateTarget > 600000);
});
