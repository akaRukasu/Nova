// Télécommande : l'iPhone associé pilote la lecture de ce PC (comme Spotify Connect).
import type { Track } from '../../shared/types';
import { on } from './api';
import { library, notify } from './library';
import { currentTrack, player, playerState, timeState } from './player';

/** Titre au format de l'iPhone (artworkURL, artistID…). */
const forPhone = (t: Track) => ({
  id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration,
  artworkURL: t.artwork, artistID: t.artistId, albumID: t.albumId,
});

const fromPhone = (raw: any): Track | undefined => {
  if (!raw?.id || !raw.title) return undefined;
  const artwork = raw.artworkURL ?? raw.artwork;
  return { id: raw.id, title: raw.title, artist: raw.artist ?? '', album: raw.album ?? undefined, duration: raw.duration ?? undefined,
    artwork, artistId: raw.artistID ?? raw.artistId, albumId: raw.albumID ?? raw.albumId, square: /googleusercontent|ggpht/.test(artwork ?? '') };
};

function publish() {
  const state = playerState.get();
  const track = currentTrack();
  void window.nova.invoke('remote:state', {
    name: library.get().settings.jamName || 'PC',
    track: track ? forPhone(track) : null,
    queue: state.queue.slice(state.index + 1, state.index + 51).map(forPhone),
    playing: state.playing,
    loading: state.loading,
    time: timeState.get().time,
    duration: timeState.get().duration,
    volume: state.volume,
    shuffled: state.shuffled,
    repeat: state.repeat,
    updatedAt: Date.now(),
  });
}

let lastRemote = 0;
setInterval(publish, 1000);
playerState.subscribe(() => publish());

on('remote:command', (command: any) => {
  if (Date.now() - lastRemote > 60_000) notify('Ton iPhone contrôle la lecture');
  lastRemote = Date.now();
  const tracks = (command.tracks ?? []).map(fromPhone).filter(Boolean) as Track[];
  switch (command.action) {
    case 'play': player.resume(); break;
    case 'pause': player.pause(); break;
    case 'toggle': player.toggle(); break;
    case 'next': player.next(); break;
    case 'previous': player.previous(); break;
    case 'seek': player.seek(Number(command.value) || 0); break;
    case 'volume': player.setVolume(Math.min(1, Math.max(0, Number(command.value) || 0))); break;
    case 'shuffle': player.toggleShuffle(); break;
    case 'repeat': player.cycleRepeat(); break;
    case 'playTracks': if (tracks.length) player.play(tracks, Number(command.index) || 0, !!command.shuffled); break;
    case 'enqueue': player.enqueue(tracks); break;
    case 'playNext': if (tracks[0]) player.playNext(tracks[0]); break;
    case 'jump': {
      const position = playerState.get().index + 1 + (Number(command.value) || 0);
      if (position < playerState.get().queue.length) player.jumpTo(position);
      break;
    }
  }
  publish();
});
