const { createRequire } = require('node:module');
const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = createRequire(resolve('.vencord/package.json'))('puppeteer-core');
(async () => {
  const executablePath = [process.env.EDGE_BIN, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => p && existsSync(p));
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><body>AudioInput integration test</body>' }));
    await page.evaluateOnNewDocument(() => {
      window.Vencord = { Webpack: { Common: {
        SelectedChannelStore: { getVoiceChannelId: () => 'test-call' },
        MediaEngineStore: { isSelfMute: () => false, isSelfDeaf: () => false },
      } } };
    });
    for (const file of ['mod/media.js', 'mod/soundboard.js']) await page.evaluateOnNewDocument(readFileSync(file, 'utf8'));
    await page.goto('https://discord.com/native-audio-test');
    const result = await page.evaluate(async () => {
      const wait = async condition => {
        const deadline = performance.now() + 10000;
        while (!await condition()) { if (performance.now() > deadline) throw new Error('AudioInput integration timeout'); await new Promise(r => setTimeout(r, 40)); }
      };
      const context = new AudioContext(); await context.resume();
      const microphone = context.createMediaStreamDestination();
      const silence = context.createConstantSource(); silence.offset.value = 0; silence.connect(microphone); silence.start();
      const camera = await navigator.mediaDevices.getUserMedia({ video: true });
      const video = camera.getVideoTracks()[0];
      const original = new MediaStream([...microphone.stream.getAudioTracks(), video]);
      const input = { context, mute: false };
      const mixed = window.NovaCordAudio.attachInput(input, original);
      const peer = new RTCPeerConnection({ iceServers: [] }), remote = new RTCPeerConnection({ iceServers: [] });
      const received = new MediaStream(); remote.ontrack = ({ track }) => { if (track.kind === 'audio') received.addTrack(track); };
      const sender = peer.addTrack(mixed.getAudioTracks()[0], mixed);
      const cameraSender = peer.addTrack(mixed.getVideoTracks()[0], mixed);
      await peer.setLocalDescription(await peer.createOffer()); await wait(() => peer.iceGatheringState === 'complete');
      await remote.setRemoteDescription(peer.localDescription); await remote.setLocalDescription(await remote.createAnswer()); await wait(() => remote.iceGatheringState === 'complete');
      await peer.setRemoteDescription(remote.localDescription); await wait(() => peer.connectionState === 'connected' && received.getAudioTracks().length);
      const player = document.createElement('audio'); player.srcObject = received; player.volume = .00001; document.body.append(player); await player.play();
      const analyser = context.createAnalyser(), output = context.createGain(); output.gain.value = .00001;
      context.createMediaStreamSource(received).connect(analyser); analyser.connect(output); output.connect(context.destination);
      const wav = new ArrayBuffer(44 + 48000 * 4), view = new DataView(wav);
      const text = (offset, value) => [...value].forEach((c,i) => view.setUint8(offset+i,c.charCodeAt(0)));
      text(0,'RIFF'); view.setUint32(4,wav.byteLength-8,true); text(8,'WAVEfmt '); view.setUint32(16,16,true);
      view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,48000,true); view.setUint32(28,96000,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
      text(36,'data'); view.setUint32(40,wav.byteLength-44,true);
      for(let i=0;i<96000;i++) view.setInt16(44+i*2,Math.round(Math.sin(i*2*Math.PI*880/48000)*12000),true);
      const id = await window.NovaCordAudio.import(new File([wav], 'tone.wav'));
      await window.NovaCordAudio.setEnabled(true); await window.NovaCordAudio.play(id);
      let rms = 0;
      await wait(() => { const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples); rms = Math.sqrt(samples.reduce((s,v) => s+v*v,0)/samples.length); return rms > .025; });
      const sameAudioTrack = sender.track === mixed.getAudioTracks()[0];
      await wait(async () => [...(await cameraSender.getStats()).values()].some(s => s.type === 'outbound-rtp' && s.kind === 'video' && s.framesEncoded > 0));
      input.mute = true;
      let muteRejected = false; try { await window.NovaCordAudio.play(id); } catch { muteRejected = true; }
      window.NovaCordAudio.releaseInput(mixed);
      const cameraPreserved = video.readyState === 'live' && mixed.getVideoTracks()[0] === video;
      peer.close(); remote.close(); player.pause(); player.srcObject = null; video.stop(); await context.close();
      return { rms, sameAudioTrack, cameraPreserved, muteRejected };
    });
    assert.ok(result.rms > .025); assert.equal(result.sameAudioTrack, true);
    assert.equal(result.cameraPreserved, true); assert.equal(result.muteRejected, true);
    console.log('Discord AudioInput seam → remote WebRTC, camera and mute measured: ' + JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
