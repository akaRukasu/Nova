// Les sons passent dans la piste du micro : aucun appel à l'API soundboard payante.
(() => {
  "use strict";
  if (window.top !== window || location.hostname !== "discord.com") return;
  const nativeGetUserMedia = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
  if (!nativeGetUserMedia) return;
  const destinations = new Set();
  const playing = new Set();
  let context;
  let soundGain;
  let lastError = "";
  const storage = window.localStorage;
  let enabled = storage.getItem("novacord:audio-mixer") === "true";

  async function audioContext() {
    context ||= new AudioContext({ latencyHint: "interactive" });
    soundGain ||= context.createGain();
    await context.resume();
    if (context.state !== "running") throw new Error("Clique d'abord sur Activer la soundboard.");
    return context;
  }

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const stream = await nativeGetUserMedia(constraints);
    if (!enabled || !constraints?.audio) return stream;
    try {
      const ctx = await audioContext();
      const mic = stream.getAudioTracks()[0];
      if (!mic) return stream;
      const source = ctx.createMediaStreamSource(new MediaStream([mic]));
      const destination = ctx.createMediaStreamDestination();
      source.connect(destination);
      soundGain.connect(destination);
      const output = destination.stream.getAudioTracks()[0];
      output.enabled = mic.enabled;
      output.getSettings = () => mic.getSettings();
      output.getConstraints = () => mic.getConstraints();
      output.applyConstraints = (value) => mic.applyConstraints(value);
      const stop = output.stop.bind(output);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        destinations.delete(destination);
        source.disconnect();
        soundGain.disconnect(destination);
        stop();
        mic.stop();
      };
      output.stop = cleanup;
      mic.addEventListener("ended", cleanup, { once: true });
      destinations.add(destination);
      stream.removeTrack(mic);
      stream.addTrack(output);
      lastError = "";
    } catch (error) {
      // La voix reste utilisable même si le mixeur n'a pas pu démarrer.
      lastError = String(error.message || error);
      console.error("NovaCord : mixeur audio indisponible", error);
    }
    return stream;
  };

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
    for (const source of playing) source.stop();
    playing.clear();
  }

  async function play(id) {
    if (!enabled) throw new Error("Active la soundboard, puis reconnecte le vocal.");
    if (!destinations.size) throw new Error(lastError || "Reconnecte le vocal pour activer le mixeur sur ton micro.");
    const store = window.Vencord?.Webpack.Common.MediaEngineStore;
    if (store?.isSelfMute() || store?.isSelfDeaf()) throw new Error("Ton micro ou ton casque est coupé. Aucun son n'a été envoyé.");
    const ctx = await audioContext();
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
    // L'état du micro peut changer pendant le téléchargement.
    if (!enabled || !destinations.size || store?.isSelfMute() || store?.isSelfDeaf()) {
      throw new Error("Le vocal n'est plus prêt ou le micro est coupé.");
    }
    stopAll();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(soundGain);
    playing.add(source);
    source.onended = () => { playing.delete(source); source.disconnect(); };
    source.start();
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
    play, list, stopAll,
    status: () => ({ enabled, active: destinations.size > 0, error: lastError }),
    async setEnabled(value) {
      if (value) await audioContext();
      enabled = !!value;
      storage.setItem("novacord:audio-mixer", String(enabled));
      if (!enabled) stopAll();
    },
    setVolume(value) { if (soundGain) soundGain.gain.value = Math.min(1, Math.max(0, Number(value) || 0)); },
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
