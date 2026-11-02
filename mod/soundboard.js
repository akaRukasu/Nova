// Les sons passent dans la piste du micro : aucun appel à l'API soundboard payante.
(() => {
  "use strict";
  if (window.top !== window || location.hostname !== "discord.com") return;
  const media = window.NovaCordMedia;
  if (!media) return;
  const bindings = new Map();
  const queues = new WeakMap();
  const playing = new Set();
  const nativeInputs = new Map();
  const nativeGains = new Set();
  const monitorGains = new Set();
  const localSources = new Set();
  const temporarySounds = new Map();
  let pendingOnline = null;
  let playbackStarts = 0;
  let lastAttempt = "";
  let context;
  let soundGain;
  let playbackGeneration = 0;
  let lastError = "";
  let lastPlayback = "";
  const storage = window.localStorage;
  let monitor = storage.getItem("novacord:sound-monitor") !== "false";
  let volume = Number(storage.getItem("novacord:sound-volume") || "0.7");
  volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.7;
  let monitorVolume = Number(storage.getItem("novacord:monitor-volume") ?? volume);
  monitorVolume = Number.isFinite(monitorVolume) ? Math.min(1, Math.max(0, monitorVolume)) : 0.7;
  const META_KEY = "novacord:sound-metadata";
  let metadata;
  try { metadata = JSON.parse(storage.getItem(META_KEY) || "{}"); } catch { metadata = {}; }
  metadata = Object.assign(Object.create(null), metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {});
  function edit(id, patch) {
    const previous = metadata[id] || {};
    const next = { ...previous };
    if (typeof patch.name === "string" && patch.name.trim()) next.name = patch.name.trim().slice(0, 160);
    if (typeof patch.category === "string") next.category = patch.category.trim().slice(0, 48);
    if (typeof patch.favorite === "boolean") next.favorite = patch.favorite;
    if (typeof patch.color === "string" && /^#[0-9a-f]{6}$/i.test(patch.color)) next.color = patch.color;
    metadata[id] = next;
    storage.setItem(META_KEY, JSON.stringify(metadata));
  }
  let muteTimer;
  let watchedStore;
  let enabled = storage.getItem("novacord:audio-mixer") === "true";

  function attachInput(input, original) {
    if (!original?.getAudioTracks().length || nativeInputs.has(original)) return original;
    const source = input.context.createMediaStreamSource(new MediaStream(original.getAudioTracks()));
    const destination = input.context.createMediaStreamDestination();
    source.connect(destination);
    const mixed = new MediaStream([...destination.stream.getAudioTracks(), ...original.getVideoTracks()]);
    nativeInputs.set(mixed, { input, original, source, destination });
    muteTimer ||= setInterval(synchronizeMute, 15);
    synchronizeMute();
    return mixed;
  }
  function releaseInput(stream) {
    const entry = nativeInputs.get(stream);
    if (!entry) return;
    nativeInputs.delete(stream);
    stopAll();
    entry.source.disconnect();
    for (const track of entry.original.getAudioTracks()) track.stop();
    if (!nativeInputs.size && !bindings.size) { clearInterval(muteTimer); muteTimer = null; }
  }
  function inputsForCall() {
    const channel = window.Vencord?.Webpack?.Common?.SelectedChannelStore?.getVoiceChannelId();
    if (!channel) return [];
    return [...nativeInputs].filter(([stream, entry]) => entry.input.context.state !== "closed"
      && stream.getAudioTracks().some(track => track.readyState === "live")
      && entry.original.getAudioTracks().some(track => track.readyState === "live")).map(([,entry]) => entry);
  }

  async function audioContext(resume = true) {
    if (!context || context.state === "closed") {
      context = new AudioContext({ latencyHint: "interactive" });
      soundGain = context.createGain();
      soundGain.gain.value = volume;
    }
    // Decoding an imported file does not require playback or user activation.
    if (!resume) return context;
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
    if (!bindings.size && !nativeInputs.size) { clearInterval(muteTimer); muteTimer = null; }
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
    if (playing.size && nativeInputs.size && (muted || !inputsForCall().some(entry => !entry.input.mute))) stopAll();
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
    if (nativeInputs.size) return;
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
    request.onblocked = () => reject(new Error("Le stockage des sons est bloqué. Ferme les autres fenêtres NovaCord puis réessaie."));
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
    pendingOnline = null;
    playbackGeneration++;
    for (const source of playing) source.stop();
    playing.clear();
    localSources.clear();
  }

  async function play(id, preview = false) {
    lastAttempt = (preview ? "aperçu : " : "vocal : ") + id;
    stopAll();
    const generation = playbackGeneration;
    if (!preview) {
      if (!enabled) throw new Error("Active la soundboard.");
      if (!nativeInputs.size) await Promise.all(media.senders().map((sender) => enqueue(sender, () => wire(sender))));
      if (!inputsForCall().length && !activeBindings().length) throw new Error(lastError || "Aucune entrée vocale prête. Reconnecte le vocal puis réessaie.");
    }
    const store = window.Vencord?.Webpack.Common.MediaEngineStore;
    const blocked = () => nativeInputs.size ? !inputsForCall().some(entry => !entry.input.mute)
      : activeBindings().every((b) => !b.input.enabled || !b.output.enabled);
    if (!preview && (store?.isSelfMute() || store?.isSelfDeaf() || blocked())) throw new Error("Ton micro ou ton casque est coupé, ou la touche de parole n’est pas maintenue. Aucun son n'a été envoyé.");
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
      const sound = temporarySounds.get(id) || await stored("readonly", (store) => store.get(id));
      if (!sound) throw new Error("Son introuvable.");
      data = await sound.blob.arrayBuffer();
    }
    const buffer = await ctx.decodeAudioData(data);
    if (generation !== playbackGeneration) return;
    // L'état du micro peut changer pendant le téléchargement.
    if (!preview && (!enabled || (!inputsForCall().length && !activeBindings().length) || store?.isSelfMute() || store?.isSelfDeaf() || blocked())) {
      throw new Error("Le vocal n'est plus prêt ou le micro est coupé.");
    }
    const destinations = !preview && nativeInputs.size ? inputsForCall().filter(entry => !entry.input.mute) : [];
    for (const target of destinations.length ? destinations : [null]) {
      const owner = target?.input.context || ctx;
      await owner.resume();
      if (generation !== playbackGeneration) return;
      if (!preview && (store?.isSelfMute() || store?.isSelfDeaf() || blocked())) throw new Error("La transmission vocale a été coupée.");
      const source = owner.createBufferSource();
      source.buffer = buffer;
      const gain = target || preview ? owner.createGain() : null;
      const gains = target ? nativeGains : monitorGains;
      if (gain) { gain.gain.value = target ? volume : monitorVolume; source.connect(gain); gain.connect(target?.destination || ctx.destination); gains.add(gain); }
      else source.connect(soundGain);
      playing.add(source);
      source.onended = () => { playing.delete(source); source.disconnect(); if (gain) { gain.disconnect(); gains.delete(gain); } };
      source.start();
      playbackStarts++;
    }
    if (!preview && monitor) {
      // Use the same Windows output as the working local preview, not Discord's virtual input context.
      const source = ctx.createBufferSource(), gain = ctx.createGain();
      source.buffer = buffer; gain.gain.value = monitorVolume;
      source.connect(gain); gain.connect(ctx.destination);
      monitorGains.add(gain); playing.add(source); localSources.add(source);
      source.onended = () => { playing.delete(source); localSources.delete(source); monitorGains.delete(gain); source.disconnect(); gain.disconnect(); };
      source.start();
      playbackStarts++;
    }
    lastError = "";
    lastPlayback = preview ? "Écoute locale uniquement." : nativeInputs.size ? "Lecture dans l’entrée vocale Discord." : "Lecture dans le transmetteur WebRTC (mode de repli).";
  }

  async function list() {
    const imported = await stored("readonly", (store) => store.getAll());
    const result = imported.map(({ id, name, source_slug }) => ({ id, name, local: true, ...(source_slug ? { source_slug } : {}) }));
    try {
      const sounds = window.Vencord?.Webpack?.Common?.SoundboardStore?.getSounds?.();
      const seen = new Set();
      const groups = sounds instanceof Map || typeof sounds?.values === "function" ? sounds.values() : Object.values(sounds || {});
      for (const group of groups) for (const sound of Array.isArray(group) ? group : []) {
        const id = String(sound.soundId ?? sound.sound_id ?? sound.id ?? "");
        if (!/^\d+$/.test(id) || seen.has(id)) continue;
        seen.add(id);
        result.push({ id: "discord:" + id, name: String(sound.name || "Son Discord"), local: false });
      }
    } catch (error) { console.warn("NovaCord : sons Discord indisponibles ; les imports restent accessibles.", error); }
    return result.map((sound) => ({ ...sound, ...(metadata[sound.id] || {}) }));
  }

  async function importSound(file, id = crypto.randomUUID(), source_slug) {
    if (file.size > 8 * 1024 * 1024) throw new Error("Choisis un son de moins de 8 Mo.");
    if (!file.size) throw new Error("Le fichier audio est vide.");
    const ctx = await audioContext(false);
    try { await ctx.decodeAudioData(await file.arrayBuffer()); }
    catch { throw new Error("Format audio illisible. Essaie un fichier MP3, WAV ou OGG."); }
    await stored("readwrite", store => store.put({ id, name: file.name, blob: file, ...(source_slug ? { source_slug } : {}) }));
    return id;
  }
  window.NovaCordAudio = Object.freeze({
    play: (id) => play(id).catch((error) => { lastError = error.message; throw error; }), list, stopAll,
    preview: (id) => play(id, true), edit, attachInput, releaseInput,
    prepareOnline(token) { stopAll(); pendingOnline = token; },
    async playFile(file, token, preview = false) {
      if (token !== pendingOnline) throw new Error("Lecture Myinstants annulée.");
      const id = "online:" + crypto.randomUUID(); temporarySounds.set(id, { blob: file });
      try { await play(id, preview); } catch (error) { lastError = error.message; throw error; }
      finally { temporarySounds.delete(id); }
    },
    async importOnline(file, slug, color) {
      if (!/^[a-z0-9_-]{1,160}$/i.test(slug)) throw new Error("Son Myinstants invalide.");
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(slug));
      const id = "myinstants:" + [...new Uint8Array(hash)].slice(0,16).map(value => value.toString(16).padStart(2,"0")).join("");
      if (await stored("readonly", store => store.get(id))) return id;
      await importSound(file, id, slug); edit(id, { category: "Myinstants", color }); return id;
    },
    status: () => ({ enabled, active: inputsForCall().length > 0 || activeBindings().length > 0, senders: inputsForCall().length || activeBindings().length,
      route: nativeInputs.size ? "Discord AudioInput" : "WebRTC fallback", nativeInputs: nativeInputs.size,
      context: context?.state || "non démarré", error: lastError, lastPlayback, volume, monitor, monitorVolume,
      monitorOutput: "Sortie Windows par défaut (comme l’aperçu local)", lastAttempt, playbackStarts, activeSources: playing.size }),
    setMonitor(value) {
      monitor = !!value; storage.setItem("novacord:sound-monitor", String(monitor));
      if (!monitor) { for (const source of localSources) source.stop(); localSources.clear(); }
    },
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
    setVolume(value) { volume = Math.min(1, Math.max(0, Number(value) || 0)); if (soundGain) soundGain.gain.value = volume; for (const gain of nativeGains) gain.gain.value = volume; storage.setItem("novacord:sound-volume", String(volume)); },
    setMonitorVolume(value) { monitorVolume = Math.min(1, Math.max(0, Number(value) || 0)); for (const gain of monitorGains) gain.gain.value = monitorVolume; storage.setItem("novacord:monitor-volume", String(monitorVolume)); },
    import: file => importSound(file),
    remove: async (id) => { await stored("readwrite", (store) => store.delete(id)); delete metadata[id]; storage.setItem(META_KEY, JSON.stringify(metadata)); },
  });
})();
