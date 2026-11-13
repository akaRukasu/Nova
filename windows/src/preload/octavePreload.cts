import { contextBridge } from 'electron';

if (process.isMainFrame && location.origin === 'https://music.octavestreaming.com') {
  contextBridge.executeInMainWorld({
    func: () => {
      // L’audio et les transitions doivent continuer quand le lecteur est hors écran.
      const nativeFrame = window.requestAnimationFrame.bind(window);
      const nativeCancel = window.cancelAnimationFrame.bind(window);
      const frames = new Map<number, { native: number; timer?: ReturnType<typeof setTimeout> }>();
      let frameId = 0x40000000;
      window.requestAnimationFrame = callback => {
        const id = frameId++;
        const frame: { native: number; timer?: ReturnType<typeof setTimeout> } = { native: 0 };
        frames.set(id, frame);
        const deliver = (time: number) => {
          if (!frames.delete(id)) return;
          nativeCancel(frame.native);
          clearTimeout(frame.timer);
          callback(time);
        };
        frame.native = nativeFrame(deliver);
        frame.timer = setTimeout(() => deliver(performance.now()), 34);
        return id;
      };
      window.cancelAnimationFrame = id => {
        const frame = frames.get(id);
        if (!frame) { nativeCancel(id); return; }
        frames.delete(id);
        nativeCancel(frame.native);
        clearTimeout(frame.timer);
      };
      const players: WeakRef<HTMLAudioElement>[] = [];
      const audioIds = new WeakMap<HTMLAudioElement, number>();
      let nextAudioId = 0;
      const session = navigator.mediaSession;
      const positionState = session.setPositionState;
      const setActionHandler = session.setActionHandler;
      let active: WeakRef<HTMLAudioElement> | undefined;
      let stable: WeakRef<HTMLAudioElement> | undefined;
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
            const outgoing = stable?.deref();
            const engine = (window as Window & { __octaveEngine?: { isFading?: boolean; active?: HTMLAudioElement } }).__octaveEngine;
            const overlap = playing.length > 1 && outgoing && outgoing.volume !== 0 && playing.includes(outgoing);
            const fading = Boolean(outgoing && !outgoing.paused && !outgoing.ended
              && (overlap || (engine?.isFading && outgoing.duration - outgoing.currentTime > 0.08 && outgoing.duration - outgoing.currentTime <= 28)));
            const engineAudio = engine?.active;
            const audio = engineAudio && playing.includes(engineAudio) ? engineAudio : playing.length === 1 ? playing[0]
              : anchored && players.includes(anchored) ? anchored
                : players.length === 1 ? players[0] : undefined;
            if (audio && !fading && playing.includes(audio)) stable = new WeakRef(audio);
            if (audio && !audioIds.has(audio)) audioIds.set(audio, ++nextAudioId);
            return audio ? { position: audio.currentTime, duration: audio.duration, ended: audio.ended,
              playing: playing.length > 0, fading, outgoingPosition: fading ? outgoing?.currentTime : undefined,
              audioId: audioIds.get(audio), buffering: !audio.paused && audio.readyState < 3 } : undefined;
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
