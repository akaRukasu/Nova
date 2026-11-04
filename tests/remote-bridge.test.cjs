const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const source = readFileSync("mod/remote-bridge.js", "utf8");

test("remote commands use the existing audio player and acknowledge its actual outcome", async () => {
  const calls = [], replies = [], snapshots = [];
  let heartbeats = 0;
  let failList = false;
  const audio = { async play(id) { calls.push(["play", id]); if (id === "broken") throw new Error("Micro coupé"); },
    async preview(id) { calls.push(["preview", id]); }, stopAll() { calls.push(["stop"]); },
    setVolume(value) { calls.push(["volume", value]); }, setMonitor(value) { calls.push(["monitor", value]); }, setMonitorVolume(value) { calls.push(["monitor-volume", value]); }, async setEnabled(value) { calls.push(["enable", value]); },
    edit(id, patch) { calls.push(["edit", id, patch.favorite]); }, async remove(id) { calls.push(["delete", id]); },
    async import(file) { assert.equal(file.name, "réaction.wav"); assert.equal(await file.text(), "RIFFtest"); calls.push(["import"]); },
    prepareOnline(token) { calls.push(['prepare-online', token]); },
    async playFile(file, token) { assert.equal(await file.text(), 'RIFFtest'); calls.push(['online-play', token]); },
    async importOnline(file, slug, color) { assert.equal(file.name, 'Online'); calls.push(['online-save', slug, color]); },
    async list() { if (failList) throw new Error("Stockage bloqué"); return [{ id: "one", name: "Premier son", local: true }]; },
    status() { return { enabled: true, active: true, volume: 0.5, error: "", lastPlayback: "" }; },
  };
  const window = { NovaCordAudio: audio, __TAURI__: { core: { async invoke(command, args) {
    if (command === "get_shortcuts") return { bindings: [{ action: "sound:one", accelerator: "F8" }] };
    if (command === "sync_soundboard") {
      if (args.board) snapshots.push(args.board);
      else heartbeats++;
    }
    if (command === "take_soundboard_upload") return [...new TextEncoder().encode("RIFFtest")];
    if (command === "complete_soundboard_command") replies.push(args);
  } } } };
  window.top = window;
  vm.runInNewContext(source, { window, location: { hostname: "discord.com" }, console, File, Date, ArrayBuffer, Uint8Array, setInterval() {} });
  for (const command of [{ action: "play", id: "one" }, { action: "play", id: "broken" }, { action: "volume", volume: 0.35 },
    { action: "enable", enabled: true }, { action: "edit", id: "one", favorite: true }, { action: "stop" },
    { action: "import", upload_id: "upload", name: "r%C3%A9action.wav" }]) {
    await window.NovaCordRemote.execute({ requestId: String(replies.length), ...command });
  }
  assert.ok(heartbeats > 0, "unchanged state uses a heartbeat instead of retransmitting the catalog");
  assert.equal(replies.length, 7);
  assert.equal(replies[0].error, null);
  assert.equal(replies[1].error, "Micro coupé");
  assert.deepEqual(calls[2], ["volume", 0.35]);
  assert.ok(calls.some((call) => call[0] === "import"));
  assert.equal(snapshots.at(-1).sounds[0].shortcut, "F8");
  await window.NovaCordRemote.execute({ action: "monitor", enabled: false, requestId: "monitor-off" });
  assert.ok(calls.some(call => call[0] === "monitor" && call[1] === false));
  await window.NovaCordRemote.execute({ action: "monitor-volume", volume: 0.2, requestId: "local-volume" });
  assert.ok(calls.some(call => call[0] === "monitor-volume" && call[1] === 0.2));
  await window.NovaCordRemote.execute({ action: 'online-prepare', token: 'token', requestId: 'prep' });
  await window.NovaCordRemote.execute({ action: 'online-sound', mode: 'play', token: 'token', upload_id: 'file', name: 'Online', slug: 'test', requestId: 'online-play' });
  await window.NovaCordRemote.execute({ action: 'online-sound', mode: 'save', upload_id: 'file', name: 'Online', slug: 'test', color: '#abcdef', requestId: 'online-save' });
  assert.ok(calls.some(call => call[0] === 'online-play' && call[1] === 'token'));
  assert.ok(calls.some(call => call[0] === 'online-save' && call[1] === 'test'));
  failList = true;
  await window.NovaCordRemote.execute({ action: "refresh", requestId: "failed-refresh" });
  assert.equal(replies.at(-1).error, "Stockage bloqué");
  assert.match(snapshots.at(-1).error, /Stockage bloqué/);
});
