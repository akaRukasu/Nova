const { createRequire } = require("node:module");
const { readFileSync, existsSync } = require("node:fs");
const { resolve } = require("node:path");
const assert = require("node:assert/strict");
const upstream = createRequire(resolve(".vencord/package.json"));
const puppeteer = upstream("puppeteer-core");

(async () => {
  const executablePath = [process.env.EDGE_BIN, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((path) => path && existsSync(path));
  assert.ok(executablePath, "Navigateur Edge de test introuvable");
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.isNavigationRequest()) request.respond({ status: 200, contentType: "text/html", body: "<!doctype html><html><head></head><body><main>Discord test</main></body></html>" });
      else if (request.url() === "https://cdn.discordapp.com/soundboard-sounds/1234") {
        const rate = 48000, frames = rate * 3;
        const wav = Buffer.alloc(44 + frames * 2);
        wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
        wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
        wav.write("data", 36); wav.writeUInt32LE(frames * 2, 40);
        for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 880 / rate) * 12000), 44 + i * 2);
        request.respond({ status: 200, contentType: "audio/wav", headers: { "Access-Control-Allow-Origin": "https://discord.com" }, body: wav });
      } else request.abort();
    });
    await page.evaluateOnNewDocument(() => {
      let bindings = [{ action: "panel", accelerator: "Ctrl+Alt+KeyN" }];
      window.__TAURI__ = { core: { invoke: async (command, args) => {
        if (command === "get_shortcuts") return { bindings, errors: [] };
        if (command === "set_shortcuts") {
          const keys = args.bindings.map((binding) => binding.accelerator);
          if (new Set(keys).size !== keys.length) throw new Error("Deux raccourcis utilisent les mêmes touches.");
          bindings = structuredClone(args.bindings);
          return { bindings, errors: [] };
        }
      } } };
    });
    for (const path of ["mod/media.js", "mod/soundboard.js", "mod/vencord.bundle.js", "mod/novacord.js"]) {
      await page.evaluateOnNewDocument(readFileSync(path, "utf8"));
    }
    await page.goto("https://discord.com/app");
    await page.evaluate(() => window.NovaCord.openPanel());
    await page.waitForFunction(() => document.querySelector("#novacord-root")?.shadowRoot.querySelector(".shortcuts select"));
    assert.equal(await page.evaluate(() => !!window.Vencord.Settings.plugins.FakeNitro.enabled), true);
    assert.equal(await page.evaluate(() => window.NovaCord.version), "0.2.1");
    const clickText = (text) => page.evaluate((text) => {
      const root = document.querySelector("#novacord-root").shadowRoot;
      const button = [...root.querySelectorAll("button")].find((button) => button.textContent === text);
      if (!button) throw new Error("Bouton absent : " + text);
      button.click();
    }, text);
    await clickText("Ajouter un raccourci");
    await clickText("Enregistrer les touches");
    await page.waitForFunction(() => document.querySelector("#novacord-root").shadowRoot.textContent.includes("Appuie sur les touches"));
    await page.keyboard.down("Control");
    await page.keyboard.down("Alt");
    await page.keyboard.press("KeyL");
    await page.keyboard.up("Alt");
    await page.keyboard.up("Control");
    await clickText("Enregistrer les raccourcis");
    await page.waitForFunction(() => document.querySelector("#novacord-root").shadowRoot.textContent.includes("enregistrés et actifs"));
    const saved = await page.evaluate(() => window.__TAURI__.core.invoke("get_shortcuts"));
    assert.equal(saved.bindings[1].accelerator, "Ctrl+Alt+KeyL");
    await page.evaluate(() => window.NovaCord.openPanel());
    await page.evaluate(() => window.NovaCord.openPanel());
    await page.waitForFunction(() => document.querySelector("#novacord-root").shadowRoot.textContent.includes("Ctrl+Alt+KeyL"));
    await clickText("Tester la caméra");
    await page.waitForFunction(() => document.querySelector("#novacord-root").shadowRoot.querySelector("video").videoWidth > 0);
    await clickText("Arrêter le test caméra");
    await clickText("Activer la soundboard");
    await page.waitForFunction(() => window.NovaCordAudio.status().enabled);
    const result = await page.evaluate(async () => {
      const wait = async (condition, label) => {
        const deadline = performance.now() + 10000;
        while (!await condition()) {
          if (performance.now() > deadline) throw new Error("Délai dépassé : " + label);
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      };
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await window.NovaCordAudio.setEnabled(false);
      const camera = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
      const videoTrack = camera.getVideoTracks()[0];
      const originalAudio = camera.getAudioTracks()[0];
      const originalVideoId = videoTrack.id;
      const inputContext = new AudioContext();
      await inputContext.resume();
      const silentMicrophone = inputContext.createMediaStreamDestination().stream;
      const input = silentMicrophone.getAudioTracks()[0];
      const senderPeer = new RTCPeerConnection({ iceServers: [] });
      const receiverPeer = new RTCPeerConnection({ iceServers: [] });
      const remoteAudio = new MediaStream();
      receiverPeer.ontrack = ({ track }) => { if (track.kind === "audio") remoteAudio.addTrack(track); };
      const audioSender = senderPeer.addTrack(input, silentMicrophone);
      const videoSender = senderPeer.addTrack(videoTrack, camera);
      const gather = async (peer) => wait(() => peer.iceGatheringState === "complete", "ICE");
      await senderPeer.setLocalDescription(await senderPeer.createOffer());
      await gather(senderPeer);
      await receiverPeer.setRemoteDescription(senderPeer.localDescription);
      await receiverPeer.setLocalDescription(await receiverPeer.createAnswer());
      await gather(receiverPeer);
      await senderPeer.setRemoteDescription(receiverPeer.localDescription);
      await wait(() => senderPeer.connectionState === "connected" && remoteAudio.getAudioTracks().length > 0, "connexion WebRTC");
      const receiverContext = new AudioContext();
      await receiverContext.resume();
      const analyser = receiverContext.createAnalyser();
      const silentOutput = receiverContext.createGain();
      silentOutput.gain.value = 0;
      receiverContext.createMediaStreamSource(remoteAudio).connect(analyser);
      analyser.connect(silentOutput);
      silentOutput.connect(receiverContext.destination);
      const rms = () => {
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      };
      await sleep(400);
      const before = rms();
      await window.NovaCordAudio.setEnabled(true);
      const wiredLate = audioSender.track !== input;
      const cameraUntouched = videoSender.track.id === originalVideoId
        && camera.getAudioTracks()[0] === originalAudio && videoTrack.readyState === "live";
      // Utiliser le même chemin fetch que le bouton soundboard de Discord.
      const response = await fetch("/api/v10/channels/123/send-soundboard-sound", {
        method: "POST", body: JSON.stringify({ sound_id: "1234" }), headers: { "Content-Type": "application/json" },
      });
      await wait(() => rms() > 0.025, "son reçu par le second pair");
      const receivedRms = rms();
      input.enabled = false;
      await wait(() => audioSender.track.enabled === false, "coupure du micro respectée");
      let muteRejected = false;
      try { await window.NovaCordAudio.play("discord:1234"); } catch { muteRejected = true; }
      input.enabled = true;
      await wait(() => audioSender.track.enabled, "micro réactivé");
      await window.NovaCordAudio.setEnabled(false);
      const restored = audioSender.track === input && input.readyState === "live";
      const videoStats = [...(await videoSender.getStats()).values()].find((entry) => entry.type === "outbound-rtp" && entry.kind === "video");
      const cameraFramesSent = (videoStats?.framesEncoded || 0) > 0;

      // Mesurer aussi une vidéo 720p en transmission, indépendamment du libellé Discord.
      const canvas = document.createElement("canvas");
      canvas.width = 1280; canvas.height = 720;
      const drawing = canvas.getContext("2d");
      const drawTimer = setInterval(() => { drawing.fillStyle = "hsl(" + (performance.now() % 360) + " 80% 50%)"; drawing.fillRect(0, 0, 1280, 720); }, 33);
      const screen = canvas.captureStream(30).getVideoTracks()[0];
      const getSettings = screen.getSettings.bind(screen);
      screen.getSettings = () => ({ ...getSettings(), displaySurface: "monitor" });
      window.Vencord.Settings.plugins.WebScreenShare.resolution = "720";
      window.Vencord.Settings.plugins.WebScreenShare.frameRate = "30";
      const profile = window.NovaCordMedia.configureStreamOptions({ capture: {}, encode: {} });
      await videoSender.replaceTrack(screen);
      await wait(async () => [...(await videoSender.getStats()).values()].some((entry) => entry.type === "outbound-rtp" && entry.frameHeight === 720 && entry.frameWidth === 1280), "vidéo envoyée en 720p");
      const encoded = [...(await videoSender.getStats()).values()].find((entry) => entry.type === "outbound-rtp" && entry.kind === "video");
      const parameters = videoSender.getParameters();
      const highest = parameters.encodings.reduce((a, b) => (a.scaleResolutionDownBy || 1) < (b.scaleResolutionDownBy || 1) ? a : b);
      clearInterval(drawTimer);
      senderPeer.close(); receiverPeer.close();
      await window.NovaCordAudio.setEnabled(false);
      for (const track of camera.getTracks()) track.stop();
      screen.stop(); input.stop();
      await inputContext.close(); await receiverContext.close();
      return { wiredLate, cameraUntouched, cameraFramesSent, before, receivedRms, nativeSoundStatus: response.status,
        muteRejected, restored, configuredHeight: profile.capture.height, sentHeight: encoded.frameHeight,
        sentWidth: encoded.frameWidth, maxFramerate: highest.maxFramerate };
    });
    assert.equal(result.wiredLate, true);
    assert.equal(result.cameraUntouched, true);
    assert.equal(result.cameraFramesSent, true);
    assert.ok(result.before < 0.001, "La piste de référence doit être silencieuse");
    assert.ok(result.receivedRms > 0.025, "Le second pair doit réellement recevoir le son");
    assert.equal(result.nativeSoundStatus, 204);
    assert.equal(result.muteRejected, true);
    assert.equal(result.restored, true);
    assert.equal(result.configuredHeight, 720);
    assert.equal(result.sentHeight, 720);
    assert.equal(result.sentWidth, 1280);
    assert.equal(result.maxFramerate, 30);
    console.log("WebRTC mesuré : " + JSON.stringify(result));
    assert.deepEqual(errors, [], "Erreurs au chargement de l'application");
    console.log("Edge : caméra, raccourcis, son reçu à distance et vidéo 720p validés.");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
