(() => {
  "use strict";
  if (window.top !== window || location.hostname !== "discord.com" || window.NovaCordRemote) return;
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
  let catalog = [], catalogAt = 0, syncJob;
  function sync(force = false) {
    if (syncJob) return force ? syncJob.then(() => sync(true)) : syncJob;
    syncJob = publish(force).finally(() => { syncJob = null; });
    return syncJob;
  }
  async function publish(force) {
    const audio = window.NovaCordAudio;
    if (!audio || !window.__TAURI__?.core?.invoke) return;
    try {
      if (force || Date.now() - catalogAt > 3000) {
        const bindings = await invoke("get_shortcuts");
        const sounds = await audio.list();
        catalog = sounds.slice(0, 5000).map((sound) => ({ ...sound,
          favorite: !!sound.favorite, category: sound.category || "", color: sound.color || "#7c6bff",
          shortcut: bindings.bindings.find((binding) => binding.action === "sound:" + sound.id)?.accelerator || "",
        }));
        catalogAt = Date.now();
      }
      const status = audio.status();
      await invoke("sync_soundboard", { board: { sounds: catalog, enabled: status.enabled,
        active: status.active, volume: status.volume, error: status.error || "", last_playback: status.lastPlayback || "" } });
    } catch (error) { console.error("NovaCord : synchronisation soundboard", error); }
  }
  async function execute(command) {
    let error = null;
    try {
      const audio = window.NovaCordAudio;
      if (!audio) throw new Error("Le lecteur NovaCord n'est pas prêt.");
      switch (command.action) {
        case "play": await audio.play(command.id); break;
        case "preview": await audio.preview(command.id); break;
        case "stop": audio.stopAll(); break;
        case "volume": audio.setVolume(command.volume); break;
        case "enable": await audio.setEnabled(command.enabled); break;
        case "edit": audio.edit(command.id, command); break;
        case "delete": await audio.remove(command.id); break;
        case "refresh": break;
        case "import": {
          const bytes = await invoke("take_soundboard_upload", { id: command.upload_id });
          let name;
          try { name = decodeURIComponent(command.name); } catch { name = "son.wav"; }
          await audio.import(new File([bytes], name.slice(0, 160), { type: "application/octet-stream" }));
          break;
        }
        default: throw new Error("Commande soundboard inconnue.");
      }
      await sync(true);
    } catch (cause) { error = String(cause.message || cause); }
    await invoke("complete_soundboard_command", { requestId: command.requestId, error });
  }
  window.NovaCordRemote = Object.freeze({ execute, sync });
  setInterval(() => sync(), 1200);
  sync(true);
})();
