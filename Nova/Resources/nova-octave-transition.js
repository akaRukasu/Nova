(() => {
  'use strict';
  if (location.origin !== 'https://music.octavestreaming.com' || window.novaOctaveTransition) return;
  const protectedStores = new WeakSet();
  function preserveEnding() {
    const store = window.__octavePlayerStore;
    if (!store?.getState || !store.setState || protectedStores.has(store)) return;
    const next = store.getState().next;
    if (typeof next !== 'function') return;
    protectedStores.add(store);
    let cancelPending;
    store.setState({ next(...args) {
      cancelPending?.();
      const audio = window.__octaveEngine?.active;
      const remaining = audio && (audio.duration - audio.currentTime) / (audio.playbackRate || 1);
      const seconds = Number(args[1]) || 0;
      if (args[0] === true && audio && !audio.paused && !audio.ended && Number.isFinite(remaining) && remaining > 0.08) {
        // Le plan peut viser une fin audible estimée avant la fin du fichier.
        // Attendre sa dernière fenêtre préserve la fin et les courbes du mix natif.
        if (remaining > Math.max(0.4, seconds) + 0.05) {
          const state = store.getState();
          const trackID = state.currentTrack?.id;
          const queue = state.queue;
          const position = audio.currentTime;
          let timer;
          const cancel = () => {
            clearTimeout(timer);
            audio.removeEventListener?.('timeupdate', check);
            if (cancelPending === cancel) cancelPending = undefined;
          };
          const check = () => {
            clearTimeout(timer);
            const current = store.getState();
            if (window.__octaveEngine?.active !== audio || current.currentTrack?.id !== trackID || audio.currentTime < position - 1) {
              cancel();
              return;
            }
            const left = (audio.duration - audio.currentTime) / (audio.playbackRate || 1);
            if (!audio.paused && Number.isFinite(left) && left <= Math.max(0.4, seconds) + 0.05) {
              cancel();
              if (current.queue !== queue) args = [true, Math.min(4, Math.max(0, left)), false];
              args[1] = Math.max(0, left);
              if (args[7]) args[7] = { ...args[7], openAt: audio.currentTime, maxWindow: Math.max(0, left) };
              next.apply(current, args);
              return;
            }
            timer = setTimeout(check, 250);
          };
          cancelPending = cancel;
          audio.addEventListener?.('timeupdate', check);
          timer = setTimeout(check, 250);
          return;
        }
        args[1] = remaining;
        if (args[7]) args[7] = { ...args[7], openAt: audio.currentTime, maxWindow: remaining };
      }
      return next.apply(this, args);
    } });
  }
  Object.defineProperty(window, 'novaOctaveTransition', {
    value: track => {
      preserveEnding();
      const preview = window.__octaveAutomix?.preview;
      return String(preview?.trackId) === String(track) ? preview : null;
    },
  });
})();
