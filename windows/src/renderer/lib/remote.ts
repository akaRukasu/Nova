// Télécommande : l'iPhone associé pilote la lecture de ce PC (comme Spotify Connect).
import type { Track } from '../../shared/types';
import { isOctaveId } from '../../shared/octave';
import { api, on } from './api';
import { isLiked, library, notify, playbackOptions, toggleLike, togglePlaybackOption } from './library';
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
    artwork, artistId: raw.artistID ?? raw.artistId, albumId: raw.albumID ?? raw.albumId,
    square: isOctaveId(raw.id) || /googleusercontent|ggpht/.test(artwork ?? '') };
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
    source: state.source,
    ...playbackOptions(library.get().settings, state.source),
    liked: track ? isLiked(track.id) : false,
    playbackSourceControl: true,
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
  if (command.source !== 'mini') {
    if (Date.now() - lastRemote > 60_000) notify('Ton iPhone contrôle la lecture');
    lastRemote = Date.now();
  }
  const tracks = (command.tracks ?? []).map(fromPhone).filter(Boolean) as Track[];
  const source = command.playbackSource === 'octave' || command.playbackSource === 'youtube' ? command.playbackSource : undefined;
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
    case 'autoplay':
    case 'automix':
      if (command.source === 'mini') togglePlaybackOption(command.action, playerState.get().source);
      break;
    case 'like': {
      const track = currentTrack();
      if (command.source === 'mini' && track) toggleLike(track);
      break;
    }
    case 'playTracks': if (tracks.length) player.play(tracks, Number(command.index) || 0, !!command.shuffled, source,
      Math.max(0, Number(command.position) || 0), command.paused === true); break;
    case 'switchSource': if (source) player.switchSource(source); break;
    case 'enqueue': player.enqueue(tracks, typeof command.index === 'number' && Number.isSafeInteger(command.index) ? command.index : undefined); break;
    case 'playNext': if (tracks[0]) player.playNext(tracks[0]); break;
    case 'jump': {
      const position = playerState.get().index + 1 + (Number(command.value) || 0);
      if (position < playerState.get().queue.length) player.jumpTo(position);
      break;
    }
  }
  publish();
});

// Réseau « public » (partage de connexion…) où Windows bloque l'iPhone associé : on le signale une fois par réseau.
const warnedNetworks = new Set<string>();
async function checkNetwork() {
  if (window.nova.platform === 'android') return;
  const [network, pairing] = await Promise.all([api.phoneNetwork(), api.phonePairing()]).catch(() => [undefined, undefined]);
  if (!network || !pairing?.paired || network.allowed) return;
  const blocked = network.publicNetworks.filter((name) => !warnedNetworks.has(name));
  if (!blocked.length) return;
  blocked.forEach((name) => warnedNetworks.add(name));
  notify(`Windows bloque l’iPhone sur « ${blocked[0]} » : Importer → Depuis l’iPhone → Autoriser Nova sur tous les réseaux`);
}
setTimeout(() => void checkNetwork(), 8000);
setInterval(() => void checkNetwork(), 60_000);
