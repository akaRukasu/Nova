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
  const screenTracks = new WeakSet();
  const previousStats = new Map();
  let streamOptions;
  let capture;
  let cameraError = "";
  let captureError = "";
  let selected = { height: 1080, frameRate: 60 };

  function quality() {
    const settings = window.Vencord?.Settings.plugins.WebScreenShare;
    return { height: Number(settings?.resolution || selected.height), frameRate: Number(settings?.frameRate || selected.frameRate) };
  }

  function bitrate(profile) {
    return Math.round(Math.min(24000000, Math.max(2000000, profile.height / 1080 * profile.frameRate / 60 * 10000000)));
  }

  function configureStreamOptions(options) {
    streamOptions = options;
    const profile = quality();
    selected = { ...profile };
    const width = Math.round(profile.height * 16 / 9);
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
    const sourceHeight = sender.track.getSettings().height || selected.height;
    // Conserver les couches basses de Discord et régler la couche la plus haute.
    const top = parameters.encodings.reduce((a, b) => (a.scaleResolutionDownBy || 1) <= (b.scaleResolutionDownBy || 1) ? a : b);
    Object.assign(top, { scaleResolutionDownBy: Math.max(1, sourceHeight / selected.height),
      maxFramerate: selected.frameRate, maxBitrate: bitrate(selected) });
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

  if (getUserMedia) devices.getUserMedia = async function (constraints) {
    try {
      const stream = await getUserMedia(constraints);
      if (constraints?.video) cameraError = "";
      return stream;
    } catch (error) {
      const video = constraints?.video;
      if (error.name === "OverconstrainedError" && video && typeof video === "object"
          && ["width", "height", "frameRate", "aspectRatio"].includes(error.constraint)) {
        const relaxed = { ...video };
        for (const key of ["width", "height", "frameRate", "aspectRatio"]) delete relaxed[key];
        try {
          const stream = await getUserMedia({ ...constraints, video: relaxed });
          cameraError = "Résolution automatique : le format caméra demandé n'était pas pris en charge.";
          return stream;
        } catch (retryError) { error = retryError; }
      }
      if (constraints?.video) cameraError = error.name + " : " + error.message;
      throw error;
    }
  };

  if (getDisplayMedia) devices.getDisplayMedia = async function (options = {}) {
    const value = (constraint, fallback) => Number(typeof constraint === "object" ? constraint?.ideal ?? constraint?.max ?? fallback : constraint || fallback);
    selected = { height: value(options.video?.height, quality().height), frameRate: value(options.video?.frameRate, quality().frameRate) };
    if (streamOptions) configureStreamOptions(streamOptions);
    captureError = "";
    try {
      const stream = await getDisplayMedia(options);
      for (const track of stream.getVideoTracks()) {
        screenTracks.add(track);
        try {
          await track.applyConstraints({ height: { ideal: selected.height, max: selected.height }, frameRate: { ideal: selected.frameRate, max: selected.frameRate } });
        } catch (error) { captureError = error.message; }
        capture = track;
      }
      return stream;
    } catch (error) { captureError = error.name + " : " + error.message; throw error; }
  };

  async function diagnostics() {
    const outgoing = [];
    for (const [sender, peer] of senders) {
      if (peer.connectionState === "closed" || !sender.track || sender.track.readyState !== "live") continue;
      try {
        const stats = await sender.getStats();
        for (const report of stats.values()) if (report.type === "outbound-rtp" && !report.isRemote) {
          const previous = previousStats.get(report.id);
          previousStats.set(report.id, report);
          outgoing.push({ kind: report.kind || report.mediaType, screen: isScreen(sender.track),
            width: report.frameWidth, height: report.frameHeight, frameRate: report.framesPerSecond,
            bytesSent: report.bytesSent, packetsSent: report.packetsSent,
            bitrate: previous && report.timestamp > previous.timestamp ? Math.round(8000 * (report.bytesSent - previous.bytesSent) / (report.timestamp - previous.timestamp)) : null,
            limitation: report.qualityLimitationReason || null });
        }
      } catch {}
    }
    return { requested: { ...selected }, capture: capture?.readyState === "live" ? capture.getSettings() : null,
      cameraError, captureError, outgoing };
  }

  window.NovaCordMedia = Object.freeze({
    configureStreamOptions, diagnostics,
    senderState: (sender) => senders.get(sender)?.connectionState,
    senders: () => [...senders].filter(([, peer]) => peer.connectionState !== "closed").map(([sender]) => sender),
    onSender(callback) { listeners.add(callback); for (const sender of senders.keys()) callback(sender); },
    replaceTrack: (sender, track) => nativeReplace.call(sender, track),
    devices: () => devices.enumerateDevices(),
    testCamera: (deviceId) => devices.getUserMedia({ audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : true }),
  });
})();
