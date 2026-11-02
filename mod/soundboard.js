// Les sons passent dans la piste du micro : aucun appel à l'API soundboard payante.
(() => {
  "use strict";
  if (window.top !== window || location.hostname !== "discord.com") return;
  const media = window.NovaCordMedia;
  if (!media) return;
  const bindings = new Map();
  const queues = new WeakMap();
  const playing = new Set();
  let context;
  let soundGain;
  let playbackGeneration = 0;
  let lastError = "";
  let lastPlayback = "";
  let volume = 0.7;
  let muteTimer;
  let watchedStore;
  const storage = window.localStorage;
  let enabled = storage.getItem("novacord:audio-mixer") === "true";

  async function audioContext() {
    if (!context || context.state === "closed") {
      context = new AudioContext({ latencyHint: "interactive" });
      soundGain = context.createGain();
      soundGain.gain.value = volume;
    }
    let timeout;
    try {
      await Promise.race([context.resume(), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Le moteur audio est suspendu. Clique sur Activer la soundboard.")), 2500);
      })]);
    } finally { clearTimeout(timeout); }
    if (context.state !== "running") throw new Error("Le moteur audio est suspendu.");
    return context;
  }

  function release(sender) {
    const binding = bindings.get(sender);
    if (!binding) return;
    bindings.delete(sender);
    binding.source.disconnect();
    soundGain.disconnect(binding.destination);
    binding.output.stop();
    if (!bindings.size) { clearInterval(muteTimer); muteTimer = null; }
    // Discord reste propriétaire du microphone original : ne pas l'arrêter ici.
  }

  function enqueue(sender, operation) {
    const next = (queues.get(sender) || Promise.resolve()).catch(() => {}).then(operation);
    queues.set(sender, next);
    next.catch((error) => { lastError = String(error.message || error); });
    return next;
  }

  function synchronizeMute() {
    const store = window.Vencord?.Webpack.Common.MediaEngineStore;
    if (store && store !== watchedStore) {
      watchedStore = store;
      store.addChangeListener?.(synchronizeMute);
    }
    const muted = !!(store?.isSelfMute() || store?.isSelfDeaf());
    for (const binding of bindings.values()) {
      const allowed = binding.input.enabled && !muted;
      if (allowed !== binding.lastAllowed) {
        binding.output.enabled = allowed;
        binding.lastAllowed = allowed;
        if (!allowed) stopAll();
      }
    }
  }

  async function wire(sender) {
    const previous = bindings.get(sender);
    if (previous && sender.track === previous.output && previous.input.readyState === "live" && previous.output.readyState === "live") return;
    if (previous) release(sender);
    const input = sender.track;
    if (!enabled || input?.kind !== "audio" || input.readyState !== "live" || media.isScreenAudio?.(input)) return;
    const ctx = await audioContext();
    if (!enabled || sender.track !== input || input.readyState !== "live") return;
    const source = ctx.createMediaStreamSource(new MediaStream([input]));
    const destination = ctx.createMediaStreamDestination();
    destination.channelCount = Math.max(1, Math.min(2, input.getSettings?.().channelCount || 1));
    const output = destination.stream.getAudioTracks()[0];
    const store = window.Vencord?.Webpack.Common.MediaEngineStore;
    const allowed = input.enabled && !(store?.isSelfMute() || store?.isSelfDeaf());
    output.enabled = allowed;
    source.connect(destination);
    soundGain.connect(destination);
    try {
      await media.replaceTrack(sender, output);
      bindings.set(sender, { input, source, destination, output, lastAllowed: allowed });
      muteTimer ||= setInterval(synchronizeMute, 15);
      synchronizeMute();
      lastError = "";
    } catch (error) {
      source.disconnect();
      soundGain.disconnect(destination);
      output.stop();
      throw error;
    }
  }

  media.onSender((sender, closed) => {
    if (closed) enqueue(sender, () => release(sender));
    else enqueue(sender, () => wire(sender));
  });

  function activeBindings() {
    return [...bindings].filter(([sender, b]) => sender.track === b.output
      && (!media.senderState || media.senderState(sender) === "connected")
      && b.output.readyState === "live" && b.input.readyState === "live").map(([, b]) => b);
  }

  const database = new Promise((resolve, reject) => {
    const request = indexedDB.open("NovaCordSoundboard", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sounds", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.catch(() => {});

  async function stored(mode, operation) {
    const db = await database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sounds", mode);
      const request = operation(tx.objectStore("sounds"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Enregistrement interrompu."));
    });
  }

  function stopAll() {
    playbackGeneration++;
    for (const source of playing) source.stop();
    playing.clear();
  }

  async function play(id, preview = false) {
    stopAll();
    const generation = playbackGeneration;
    if (!preview) {
      if (!enabled) throw new Error("Active la soundboard.");
      await Promise.all(media.senders().map((sender) => enqueue(sender, () => wire(sender))));
      if (!activeBindings().length) throw new Error(lastError || "Aucune piste vocale envoyée. Rejoins un salon vocal et ouvre ton micro.");
    }
    const store = window.Vencord?.Webpack.Common.MediaEngineStore;
    if (!preview && (store?.isSelfMute() || store?.isSelfDeaf() || activeBindings().every((b) => !b.input.enabled || !b.output.enabled))) throw new Error("Ton micro ou ton casque est coupé. Aucun son n'a été envoyé.");
    const ctx = await audioContext();
    if (generation !== playbackGeneration) return;
    let data;
    if (id.startsWith("discord:")) {
      const soundId = id.slice(8);
      if (!/^\d+$/.test(soundId)) throw new Error("Son invalide.");
      const response = await fetch(`https://cdn.discordapp.com/soundboard-sounds/${soundId}`);
      if (!response.ok) throw new Error("Ce son Discord n'est pas téléchargeable.");
      data = await response.arrayBuffer();
    } else {
      const sound = await stored("readonly", (store) => store.get(id));
      if (!sound) throw new Error("Son introuvable.");
      data = await sound.blob.arrayBuffer();
    }
    const buffer = await ctx.decodeAudioData(data);
    if (generation !== playbackGeneration) return;
    // L'état du micro peut changer pendant le téléchargement.
    if (!preview && (!enabled || !activeBindings().length || store?.isSelfMute() || store?.isSelfDeaf()
        || activeBindings().every((b) => !b.input.enabled || !b.output.enabled))) {
      throw new Error("Le vocal n'est plus prêt ou le micro est coupé.");
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(preview ? ctx.destination : soundGain);
    playing.add(source);
    source.onended = () => { playing.delete(source); source.disconnect(); };
    source.start();
    lastError = "";
    lastPlayback = preview ? "Écoute locale uniquement." : "Son lancé sur la piste vocale sortante.";
  }

  async function list() {
    const imported = await stored("readonly", (store) => store.getAll());
    const result = imported.map(({ id, name }) => ({ id, name, local: true }));
    const sounds = window.Vencord?.Webpack.Common.SoundboardStore?.getSounds();
    if (sounds) {
      const seen = new Set();
      for (const group of sounds.values()) for (const sound of group) {
        const id = String(sound.soundId ?? sound.sound_id ?? sound.id ?? "");
        if (!/^\d+$/.test(id) || seen.has(id)) continue;
        seen.add(id);
        result.push({ id: "discord:" + id, name: sound.name, local: false });
      }
    }
    return result;
  }

  window.NovaCordAudio = Object.freeze({
    play: (id) => play(id).catch((error) => { lastError = error.message; throw error; }), list, stopAll,
    preview: (id) => play(id, true),
    status: () => ({ enabled, active: activeBindings().length > 0, senders: activeBindings().length,
      context: context?.state || "non démarré", error: lastError, lastPlayback, volume }),
    async setEnabled(value) {
      if (value) await audioContext();
      enabled = !!value;
      storage.setItem("novacord:audio-mixer", String(enabled));
      if (!enabled) stopAll();
      await Promise.all(media.senders().map((sender) => enqueue(sender, async () => {
        const binding = bindings.get(sender);
        if (enabled) return wire(sender);
        if (binding) {
          if (!binding.output.enabled) binding.input.enabled = false;
          if (sender.track === binding.output) await media.replaceTrack(sender, binding.input.readyState === "live" ? binding.input : null);
          release(sender);
        }
      })));
    },
    setVolume(value) { volume = Math.min(1, Math.max(0, Number(value) || 0)); if (soundGain) soundGain.gain.value = volume; },
    async import(file) {
      if (file.size > 8 * 1024 * 1024) throw new Error("Choisis un son de moins de 8 Mo.");
      const ctx = await audioContext();
      await ctx.decodeAudioData(await file.arrayBuffer());
      const sound = { id: crypto.randomUUID(), name: file.name, blob: file };
      await stored("readwrite", (store) => store.put(sound));
      return sound.id;
    },
    remove: (id) => stored("readwrite", (store) => store.delete(id)),
  });
})();
