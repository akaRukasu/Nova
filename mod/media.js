(() => {
  "use strict";
  if (window.top !== window || location.hostname !== "discord.com" || window.NovaCordMedia) return;
  const devices = navigator.mediaDevices;
  const getUserMedia = devices?.getUserMedia?.bind(devices);
  const getDisplayMedia = devices?.getDisplayMedia?.bind(devices);
  const NativePeer = window.RTCPeerConnection;
  const nativeReplace = window.RTCRtpSender?.prototype.replaceTrack;
  const nativeParameters = window.RTCRtpSender?.prototype.setParameters;
  const senders = new Map();
  const peers = new Set();
  const listeners = new Set();
  const screenTracks = new WeakMap();
  const screenAudioTracks = new WeakSet();
  const previousStats = new Map();
  const cameraTracks = new Map();
  const storage = window.localStorage;
  const CAMERA_KEY = "novacord:call-camera";
  let cameraChoice = null;
  try {
    const saved = JSON.parse(storage?.getItem(CAMERA_KEY) || "null");
    if (typeof saved?.id === "string" && saved.id.length <= 512 && saved.id) cameraChoice = { id: saved.id, name: String(saved.name || "Caméra choisie").slice(0,160) };
  } catch {}
  let streamOptions;
  let capture;
  let cameraError = "";
  let captureError = "";
  let selected = { height: 1080, frameRate: 60 };
  function rememberCamera(stream, role, requestedDevice) {
    for (const track of stream.getVideoTracks?.() || []) cameraTracks.set(track, { role, requestedDevice });
    return stream;
  }
  async function selectCamera(id) {
    if (!id) { cameraChoice = null; storage?.setItem(CAMERA_KEY, "null"); return; }
    const device = (await devices.enumerateDevices()).find(device => device.kind === "videoinput" && device.deviceId === id);
    if (!device) throw new Error("Cette caméra n’est plus disponible. Actualise la liste puis sélectionne-la à nouveau.");
    cameraChoice = { id, name: device.label || "Caméra choisie" };
    storage?.setItem(CAMERA_KEY, JSON.stringify(cameraChoice));
  }

  function quality() {
    const settings = window.Vencord?.Settings.plugins.WebScreenShare;
    return { height: Number(settings?.resolution || selected.height), frameRate: Number(settings?.frameRate || selected.frameRate) };
  }

  function bitrate(profile) {
    return Math.round(Math.min(24000000, Math.max(2000000, profile.height / 1080 * profile.frameRate / 60 * 10000000)));
  }

  function configureStreamOptions(options, profile, source) {
    if (!profile) {
      const liveCapture = capture?.readyState === "live" ? capture : null;
      profile = screenTracks.get(liveCapture) || quality();
      source = liveCapture?.getSettings();
    }
    streamOptions = options;
    selected = { ...profile };
    const aspect = source?.width && source?.height ? source.width / source.height : 16 / 9;
    const width = Math.max(2, 2 * Math.round(profile.height * aspect / 2));
    const budget = bitrate(profile);
    Object.assign(options, { bitrateMin: 500000, bitrateMax: budget, bitrateTarget: Math.round(budget * 0.8) });
    for (const key of ["capture", "encode"]) {
      if (options[key]) Object.assign(options[key], { width, height: profile.height, framerate: profile.frameRate, pixelCount: width * profile.height });
    }
    return options;
  }

  function isScreen(track) {
    return !!track && track.kind === "video" && (screenTracks.has(track) || !!track.getSettings().displaySurface);
  }

  function screenParameters(sender, parameters) {
    if (!isScreen(sender.track) || !parameters.encodings?.length) return parameters;
    const profile = screenTracks.get(sender.track) || selected;
    const sourceHeight = sender.track.getSettings().height || profile.height;
    // Conserver les couches basses de Discord et régler la couche la plus haute.
    const top = parameters.encodings.reduce((a, b) => (a.scaleResolutionDownBy || 1) <= (b.scaleResolutionDownBy || 1) ? a : b);
    Object.assign(top, { scaleResolutionDownBy: Math.max(1, sourceHeight / profile.height),
      maxFramerate: profile.frameRate, maxBitrate: bitrate(profile) });
    return parameters;
  }

  function configureSender(sender) {
    try {
      if (!isScreen(sender.track)) return;
      const parameters = sender.getParameters();
      if (parameters.encodings?.length) nativeParameters.call(sender, screenParameters(sender, parameters))
        .catch((error) => { captureError = error.message; });
    } catch (error) { captureError = error.message; }
  }

  function observe(sender, peer) {
    if (!sender) return;
    if (peer) senders.set(sender, peer);
    for (const listener of listeners) {
      try { listener(sender); } catch (error) { console.error("NovaCord : suivi audio indisponible", error); }
    }
    configureSender(sender);
  }

  if (NativePeer && nativeReplace) {
    const proto = NativePeer.prototype;
    const addTrack = proto.addTrack;
    const addTransceiver = proto.addTransceiver;
    const close = proto.close;
    window.RTCPeerConnection = new Proxy(NativePeer, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget);
        peers.add(peer);
        peer.addEventListener("connectionstatechange", () => {
          if (peer.connectionState === "connected") for (const sender of peer.getSenders()) configureSender(sender);
        });
        return peer;
      },
    });
    proto.addTrack = function (...args) {
      const sender = addTrack.apply(this, args);
      observe(sender, this);
      return sender;
    };
    proto.addTransceiver = function (...args) {
      const transceiver = addTransceiver.apply(this, args);
      observe(transceiver.sender, this);
      return transceiver;
    };
    proto.close = function () {
      close.call(this);
      peers.delete(this);
      for (const [sender, peer] of senders) if (peer === this) {
        senders.delete(sender);
        for (const listener of listeners) {
          try { listener(sender, true); } catch {}
        }
      }
    };
    window.RTCRtpSender.prototype.replaceTrack = function (track) {
      return nativeReplace.call(this, track).then(() => observe(this, senders.get(this) || [...peers].find((peer) => peer.getSenders().includes(this))));
    };
    window.RTCRtpSender.prototype.setParameters = function (parameters) {
      return nativeParameters.call(this, screenParameters(this, parameters));
    };
  }

  if (window.MediaStreamTrack) {
    const clone = window.MediaStreamTrack.prototype.clone;
    window.MediaStreamTrack.prototype.clone = function () {
      const result = clone.call(this);
      if (screenTracks.has(this)) screenTracks.set(result, screenTracks.get(this));
      if (screenAudioTracks.has(this)) screenAudioTracks.add(result);
      if (cameraTracks.has(this)) cameraTracks.set(result, cameraTracks.get(this));
      return result;
    };
  }

  async function captureUserMedia(constraints, role = "discord") {
    const video = constraints?.video;
    const camera = !!video && !video.mandatory?.chromeMediaSource && !["screen", "window", "browser", "application"].includes(video.mediaSource) && !video.displaySurface;
    if (camera && role === "discord") {
      for (const [track, request] of cameraTracks) {
        if (request.role === "test") {
          track.stop();
          cameraTracks.delete(track);
        }
      }
      if (cameraChoice) {
        constraints = { ...constraints, video: { ...(typeof video === "object" ? video : {}), deviceId: { exact: cameraChoice.id } } };
      }
    }
    const device = constraints?.video?.deviceId;
    const requestedDevice = typeof device === "string" ? device : device?.exact || device?.ideal;
    try {
      const stream = await getUserMedia(constraints);
      if (constraints?.video) cameraError = "";
      return camera ? rememberCamera(stream, role, requestedDevice) : stream;
    } catch (error) {
      const video = constraints?.video;
      if (error.name === "OverconstrainedError" && video && typeof video === "object"
          && ["width", "height", "frameRate", "aspectRatio"].includes(error.constraint)) {
        const relaxed = { ...video };
        for (const key of ["width", "height", "frameRate", "aspectRatio"]) delete relaxed[key];
        try {
          const stream = await getUserMedia({ ...constraints, video: relaxed });
          cameraError = "Résolution automatique : le format caméra demandé n'était pas pris en charge.";
          return camera ? rememberCamera(stream, role, requestedDevice) : stream;
        } catch (retryError) { error = retryError; }
      }
      if (constraints?.video) cameraError = error.name + " : " + error.message;
      throw error;
    }
  }
  if (getUserMedia) devices.getUserMedia = constraints => captureUserMedia(constraints, "discord");

  if (getDisplayMedia) devices.getDisplayMedia = async function (options = {}) {
    const value = (constraint, fallback) => {
      const requested = Number(typeof constraint === "object" ? constraint?.ideal ?? constraint?.max : constraint);
      return Number.isFinite(requested) && requested > 0 ? requested : fallback;
    };
    const defaults = quality();
    const profile = { height: value(options.video?.height, defaults.height), frameRate: value(options.video?.frameRate, defaults.frameRate) };
    captureError = "";
    try {
      const stream = await getDisplayMedia(options);
      for (const track of stream.getAudioTracks()) screenAudioTracks.add(track);
      for (const track of stream.getVideoTracks()) {
        screenTracks.set(track, profile);
        try {
          await track.applyConstraints({ height: { ideal: profile.height, max: profile.height }, frameRate: { ideal: profile.frameRate, max: profile.frameRate } });
        } catch (error) { captureError = error.message; }
        capture = track;
        selected = profile;
        if (streamOptions) configureStreamOptions(streamOptions, profile, track.getSettings());
      }
      return stream;
    } catch (error) { captureError = error.name + " : " + error.message; throw error; }
  };

  async function diagnostics({ includeIncoming = false } = {}) {
    const outgoing = [];
    for (const [sender, peer] of senders) {
      if (peer.connectionState === "closed" || !sender.track || sender.track.readyState !== "live") continue;
      try {
        const stats = await sender.getStats();
        for (const report of stats.values()) if (report.type === "outbound-rtp" && !report.isRemote) {
          const previous = previousStats.get(report.id);
          previousStats.set(report.id, report);
          outgoing.push({ kind: report.kind || report.mediaType, screen: isScreen(sender.track),
            trackName: sender.track.label,
            cameraRole: cameraTracks.get(sender.track)?.role,
            trackEnabled: sender.track.enabled, trackMuted: sender.track.muted,
            framesEncoded: report.framesEncoded, audioLevel: report.audioLevel,
            codec: stats.get(report.codecId)?.mimeType,
            width: report.frameWidth, height: report.frameHeight, frameRate: report.framesPerSecond,
            bytesSent: report.bytesSent, packetsSent: report.packetsSent,
            bitrate: previous && report.timestamp > previous.timestamp ? Math.round(8000 * (report.bytesSent - previous.bytesSent) / (report.timestamp - previous.timestamp)) : null,
            limitation: report.qualityLimitationReason || null });
        }
      } catch {}
    }
    const incomingVideo = [];
    if (includeIncoming) {
      await Promise.all([...peers].filter(peer => peer.connectionState !== "closed").map(async peer => {
        try {
          const stats = await peer.getStats();
          for (const report of stats.values()) {
            if (report.type !== "inbound-rtp" || (report.kind || report.mediaType) !== "video") continue;
            incomingVideo.push({
              codec: stats.get(report.codecId)?.mimeType,
              width: report.frameWidth, height: report.frameHeight, frameRate: report.framesPerSecond,
              bytesReceived: report.bytesReceived, packetsLost: report.packetsLost,
              framesReceived: report.framesReceived, framesDecoded: report.framesDecoded,
              framesDropped: report.framesDropped, freezeCount: report.freezeCount,
            });
          }
        } catch {}
      }));
    }
    const store = window.Vencord?.Webpack?.Common?.MediaEngineStore;
    const read = method => { try { return store?.[method]?.() ?? null; } catch { return null; } };
    const name = (devices, id) => (devices || {})[id]?.name || Object.values(devices || {}).find(device => device.id === id)?.name || id;
    const cameras = [];
    for (const [track, request] of cameraTracks) {
      if (track.readyState !== "live") { cameraTracks.delete(track); continue; }
      const settings = track.getSettings();
      cameras.push({ name: track.label, role: request.role,
        matchesRequestedDevice: typeof request.requestedDevice === "string" && settings.deviceId ? settings.deviceId === request.requestedDevice : null,
        enabled: track.enabled, muted: track.muted,
        width: settings.width, height: settings.height, frameRate: settings.frameRate });
    }
    return { requested: { ...(capture?.readyState === "live" ? screenTracks.get(capture) : selected) }, capture: capture?.readyState === "live" ? capture.getSettings() : null,
      cameraError, captureError, outgoing, ...(includeIncoming ? { incomingVideo } : {}), cameras, cameraChoice: cameraChoice ? { name: cameraChoice.name, forced: true } : null,
      discord: { input: name(read("getInputDevices"), read("getInputDeviceId")),
        output: name(read("getOutputDevices"), read("getOutputDeviceId")),
        camera: name(read("getVideoDevices"), read("getVideoDeviceId")),
        voiceMode: read("getMode"), muted: read("isSelfMute"), deafened: read("isSelfDeaf"), videoEnabled: read("isVideoEnabled") },
      connections: [...peers].map(peer => ({ state: peer.connectionState, ice: peer.iceConnectionState, signaling: peer.signalingState })) };
  }

  window.NovaCordMedia = Object.freeze({
    configureStreamOptions, diagnostics,
    isScreenAudio: (track) => screenAudioTracks.has(track),
    senderState: (sender) => senders.get(sender)?.connectionState,
    senders: () => [...senders].filter(([, peer]) => peer.connectionState !== "closed").map(([sender]) => sender),
    onSender(callback) { listeners.add(callback); for (const sender of senders.keys()) callback(sender); },
    replaceTrack: (sender, track) => nativeReplace.call(sender, track),
    devices: () => devices.enumerateDevices(),
    cameraChoice: () => cameraChoice ? { ...cameraChoice } : null,
    selectCamera,
    testCamera: (deviceId) => captureUserMedia({ audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : true }, "test"),
  });
})();
