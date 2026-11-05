// Ligne de titre : pochette, titre, artiste, album, durée ; double-clic pour lire, clic droit pour le menu.
import type { Track } from '../../shared/types';
import { isAndroid } from '../lib/api';
import { isLiked, toggleLike } from '../lib/library';
import { playerState } from '../lib/player';
import { open } from '../lib/router';
import { useStore } from '../lib/store';
import { Artwork } from './Artwork';
import { Icon } from './icons';
import { showMenu, trackMenu, type MenuItem } from './menus';
import { library } from '../lib/library';

export function formatTime(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds)) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function TrackRow({ track, index, onPlay, showArtwork = true, showAlbum = true, extraMenu, rank }: {
  track: Track; index?: number; onPlay: () => void; showArtwork?: boolean; showAlbum?: boolean; extraMenu?: MenuItem[]; rank?: number;
}) {
  const state = useStore(playerState);
  useStore(library);
  const current = state.queue[state.index]?.id === track.id;
  const liked = isLiked(track.id);
  return (
    <div className={`track-row ${current ? 'current' : ''}`} onDoubleClick={isAndroid ? undefined : onPlay}
      onClick={isAndroid ? (e) => { if (!(e.target as HTMLElement).closest('button, .link')) onPlay(); } : undefined}
      onContextMenu={(e) => showMenu(e, trackMenu(track, extraMenu))}>
      {rank != null && <span className={`rank ${rank < 3 ? 'top' : ''}`}>{rank + 1}</span>}
      {showArtwork ? (
        <button className="row-artwork" onClick={onPlay} aria-label={`Lire ${track.title}`}>
          <Artwork track={track} size={40} radius={6} />
          <span className="row-play">{current && state.playing ? <span className="bars"><i /><i /><i /></span> : <Icon name="play" size={16} />}</span>
        </button>
      ) : (
        <button className="row-index" onClick={onPlay}>
          <span className="number">{current && state.playing ? <span className="bars"><i /><i /><i /></span> : (index ?? 0) + 1}</span>
          <Icon name="play" size={14} className="hover-play" />
        </button>
      )}
      <div className="row-text">
        <div className="row-title">{track.title}</div>
        <div className="row-subtitle">
          {track.artistId
            ? <span className="link" onClick={(e) => { e.stopPropagation(); open({ name: 'artist', id: track.artistId!, title: track.artist }); }}>{track.artist}</span>
            : track.artist}
        </div>
      </div>
      {showAlbum && (
        <div className="row-album">
          {track.albumId
            ? <span className="link" onClick={() => open({ name: 'collection', collection: { id: track.albumId!, kind: 'album', title: track.album ?? '' } })}>{track.album}</span>
            : track.album}
        </div>
      )}
      <button className={`row-like ${liked ? 'on' : ''}`} onClick={() => toggleLike(track)} aria-label="J’aime">
        <Icon name="heart" size={16} solid={liked} />
      </button>
      <span className="row-duration">{formatTime(track.duration)}</span>
      <button className="row-more" onClick={(e) => showMenu(e, trackMenu(track, extraMenu))} aria-label="Plus">
        <Icon name="more" size={18} strokeWidth={3} />
      </button>
    </div>
  );
}
