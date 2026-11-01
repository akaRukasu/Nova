const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const bootstrap = readFileSync("mod/vencord-bootstrap.js", "utf8");
const mixer = readFileSync("mod/soundboard.js", "utf8");

test("Vencord defaults enable stream patches before startup, preserving choices", () => {
  let saved = JSON.stringify({ plugins: { FakeNitro: { enabled: false }, WebScreenShare: { resolution: "1440" } } });
  const context = { localStorage: { getItem: () => saved, setItem: (_, value) => { saved = value; } }, console };
  vm.runInNewContext(bootstrap, context);
  const settings = JSON.parse(saved);
  assert.equal(settings.plugins.FakeNitro.enabled, false);
  assert.equal(settings.plugins.FakeNitro.enableStreamQualityBypass, true);
  assert.equal(settings.plugins.WebScreenShare.enabled, true);
  assert.equal(settings.plugins.WebScreenShare.resolution, "1440");
  assert.equal(settings.plugins.WebScreenShare.frameRate, "60");
  assert.equal(settings.plugins.WebKeybinds.enabled, true);
});

function setupMixer(enabled = true) {
  let muted = false;
  let fetchSound = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
  const sources = [];
  const track = () => ({ enabled: true, stopped: false, getSettings: () => ({ deviceId: "mic" }), getConstraints: () => ({}), applyConstraints: async () => {}, addEventListener() {}, stop() { this.stopped = true; } });
  const input = track();
  class Stream {
    constructor(tracks) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks; }
    removeTrack(t) { this.tracks = this.tracks.filter((v) => v !== t); }
    addTrack(t) { this.tracks.push(t); }
  }
  const original = new Stream([input]);
  class Context {
    constructor() { this.state = "suspended"; }
    resume() { this.state = "running"; return Promise.resolve(); }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createMediaStreamDestination() { return { stream: new Stream([track()]) }; }
    async decodeAudioData() { return {}; }
    createBufferSource() {
      const source = { started: false, stopped: false, connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; this.onended?.(); } };
      sources.push(source);
      return source;
    }
  }
  const window = { localStorage: { getItem: () => String(enabled), setItem() {} }, Vencord: { Webpack: { Common: { MediaEngineStore: { isSelfMute: () => muted, isSelfDeaf: () => false } } } } };
  window.top = window;
  const navigator = { mediaDevices: { getUserMedia: async () => original } };
  vm.runInNewContext(mixer, {
    window, navigator, MediaStream: Stream, AudioContext: Context,
    location: { hostname: "discord.com" }, console,
    indexedDB: { open: () => ({}) },
    fetch: (...args) => fetchSound(...args),
  });
  return { audio: window.NovaCordAudio, navigator, sources, input, original, mute: () => { muted = true; }, setFetch: (fn) => { fetchSound = fn; } };
}

test("soundboard mixes into the microphone and respects mute, stop and capture cleanup", async () => {
  const env = setupMixer();
  const mixed = await env.navigator.mediaDevices.getUserMedia({ audio: true });
  assert.equal(env.audio.status().active, true);
  const output = mixed.getAudioTracks()[0];
  assert.notEqual(output, env.input);
  assert.equal(output.getSettings().deviceId, "mic");
  await env.audio.play("discord:1234");
  assert.equal(env.sources[0].started, true);
  env.audio.stopAll();
  assert.equal(env.sources[0].stopped, true);
  env.mute();
  await assert.rejects(env.audio.play("discord:1234"), /coupé/);
  assert.equal(env.sources.length, 1);
  output.stop();
  assert.equal(env.input.stopped, true);
  assert.equal(env.audio.status().active, false);
});

test("disabled soundboard leaves the original microphone untouched", async () => {
  const env = setupMixer(false);
  assert.equal(await env.navigator.mediaDevices.getUserMedia({ audio: true }), env.original);
  assert.equal(env.original.getAudioTracks()[0], env.input);
  assert.equal(env.audio.status().active, false);
  await assert.rejects(env.audio.play("discord:1234"), /Active la soundboard/);
});

test("stop cancels a sound that is still downloading", async () => {
  const env = setupMixer();
  await env.navigator.mediaDevices.getUserMedia({ audio: true });
  let finishDownload;
  let started;
  const downloadStarted = new Promise((resolve) => { started = resolve; });
  env.setFetch(() => new Promise((resolve) => { finishDownload = resolve; started(); }));
  const pending = env.audio.play("discord:1234");
  await downloadStarted;
  env.audio.stopAll();
  finishDownload({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
  await pending;
  assert.equal(env.sources.length, 0);
});
