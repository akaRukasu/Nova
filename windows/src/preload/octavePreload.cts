import { contextBridge } from 'electron';

if (process.isMainFrame && location.origin === 'https://music.octavestreaming.com') {
  contextBridge.executeInMainWorld({
    func: () => {
      const players: WeakRef<HTMLAudioElement>[] = [];
      const session = navigator.mediaSession;
      const positionState = session.setPositionState;
      const setActionHandler = session.setActionHandler;
      let active: WeakRef<HTMLAudioElement> | undefined;
      let seekHandler: MediaSessionActionHandler | null = null;

      window.Audio = new Proxy(window.Audio, {
        construct(constructor, args, target) {
          const audio = Reflect.construct(constructor, args, target) as HTMLAudioElement;
          players.push(new WeakRef(audio));
          return audio;
        },
      });

      const availablePlayers = () => {
        for (let i = players.length - 1; i >= 0; i--) {
          if (!players[i].deref()) players.splice(i, 1);
        }
        return players.map((player) => player.deref()).filter((audio): audio is HTMLAudioElement =>
          Boolean(audio && audio.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(audio.duration) && audio.duration > 0));
      };

      session.setPositionState = function (state) {
        positionState.call(this, state);
        if (!state?.duration || state.position == null) return;
        const position = state.position;
        const candidates = availablePlayers().filter((audio) => Math.abs(audio.duration - state.duration!) < 0.25);
        const nearest = candidates.sort((a, b) => Math.abs(a.currentTime - position) - Math.abs(b.currentTime - position))[0];
        if (nearest && Math.abs(nearest.currentTime - position) < 0.5) active = new WeakRef(nearest);
      };

      session.setActionHandler = function (action, handler) {
        setActionHandler.call(this, action, handler);
        if (action === 'seekto') seekHandler = handler;
      };

      // Seule la position du lecteur est exposée. Aucun pont IPC ou accès à la session Nova.
      Object.defineProperty(window, '__novaOctaveMedia', {
        value: {
          read() {
            const players = availablePlayers();
            const playing = players.filter((audio) => !audio.paused && !audio.ended);
            const anchored = active?.deref();
            const audio = playing.length === 1 ? playing[0]
              : anchored && players.includes(anchored) ? anchored
                : players.length === 1 ? players[0] : undefined;
            return audio ? { position: audio.currentTime, duration: audio.duration, ended: audio.ended } : undefined;
          },
          seek(seconds: number) {
            if (!seekHandler || !Number.isFinite(seconds) || seconds < 0) return false;
            seekHandler({ action: 'seekto', seekTime: seconds });
            return true;
          },
        },
      });
    },
  });
}
