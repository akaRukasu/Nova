// Barre de lecture (en bas), lecteur plein écran (pochette, paroles synchronisées, file d'attente).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Lyrics, Track } from '../../shared/types';
import { api, isAndroid, supportsOctave } from '../lib/api';
import { jam } from '../lib/jam';
import { isLiked, library, toggleLike } from '../lib/library';
import { currentTrack, player, playerState, timeState } from '../lib/player';
import { open } from '../lib/router';
import { Store, useStore } from '../lib/store';
import { Artwork, trackArtwork } from './Artwork';
import { Icon } from './icons';
import { showMenu, trackMenu, type MenuItem } from './menus';
import { formatTime } from './TrackRow';

export const nowPlayingOpen = new Store<false | 'artwork' | 'lyrics' | 'queue'>(false);

function Progress({ compact }: { compact?: boolean }) {
  const { time, duration } = useStore(timeState);
  const [dragging, setDragging] = useState<number | null>(null);
  const value = dragging ?? time;
  const max = duration || 1;
  return (
    <div className={`progress ${compact ? 'compact' : ''}`}>
      <span className="time">{formatTime(value) || '0:00'}</span>
      <input type="range" min={0} max={max} step={0.5} value={Math.min(value, max)}
        style={{ '--fill': `${(Math.min(value, max) / max) * 100}%` } as React.CSSProperties}
        onChange={(e) => setDragging(Number(e.target.value))}
        onMouseUp={() => { if (dragging != null) player.seek(dragging); setDragging(null); }}
        onKeyUp={() => { if (dragging != null) player.seek(dragging); setDragging(null); }} />
      <span className="time">{duration ? `-${formatTime(Math.max(0, duration - value)) || '0:00'}` : ''}</span>
    </div>
  );
}

function Volume() {
  const { volume } = useStore(playerState);
  return (
    <div className="volume">
      <button onClick={() => player.setVolume(volume > 0 ? 0 : 0.8)} aria-label="Volume"><Icon name={volume > 0 ? 'volume' : 'mute'} size={18} /></button>
      <input type="range" min={0} max={1} step={0.01} value={volume}
        style={{ '--fill': `${volume * 100}%` } as React.CSSProperties}
        onChange={(e) => player.setVolume(Number(e.target.value))} />
    </div>
  );
}

function MobileProgress() {
  const { time, duration } = useStore(timeState);
  return duration > 0 ? <progress className="mobile-progress" max={duration} value={Math.min(time, duration)} aria-label="Progression du morceau" /> : null;
}

function Controls({ large }: { large?: boolean }) {
  const state = useStore(playerState);
  const size = large ? 34 : 22;
  return (
    <div className={`controls ${large ? 'large' : ''}`}>
      <button className={`mode ${state.shuffled ? 'on' : ''}`} onClick={() => player.toggleShuffle()} aria-label="Aléatoire"><Icon name="shuffle" size={18} /></button>
      <button onClick={() => player.previous()} aria-label="Précédent"><Icon name="previous" size={size} /></button>
      <button className="play-button" onClick={() => player.toggle()} aria-label={state.playing ? 'Pause' : 'Lecture'}>
        {state.loading && !state.playing ? <span className="spinner" /> : <Icon name={state.playing ? 'pause' : 'play'} size={large ? 34 : 24} />}
      </button>
      <button onClick={() => player.next()} aria-label="Suivant"><Icon name="next" size={size} /></button>
      <button className={`mode ${state.repeat !== 'off' ? 'on' : ''}`} onClick={() => player.cycleRepeat()} aria-label="Répéter">
        <Icon name="repeat" size={18} />{state.repeat === 'one' && <small>1</small>}
      </button>
    </div>
  );
}

function sleepMenu(): MenuItem[] {
  const { sleepAt } = playerState.get();
  return [
    ...(sleepAt ? [{ label: `Arrêter la minuterie (${Math.ceil((sleepAt - Date.now()) / 60000)} min)`, action: () => player.setSleepTimer(null) }] : []),
    ...[15, 30, 45, 60, 90].map((m) => ({ label: `Dans ${m} minutes`, action: () => player.setSleepTimer(m) })),
  ];
}

export function PlayerBar() {
  const state = useStore(playerState);
  useStore(library);
  const jamState = useStore(jam);
  const track = state.queue[state.index];
  if (!track) return <footer className="player-bar empty"><span>Choisis un titre pour commencer l’écoute.</span></footer>;
  const liked = isLiked(track.id);
  return (
    <footer className="player-bar">
      <div className="beat-aura" />
      <div className="now">
        <button className="now-art" onClick={() => nowPlayingOpen.set('artwork')} aria-label="Lecteur plein écran">
          <Artwork track={track} size={56} radius={6} />
          <span className="expand"><Icon name="expand" size={18} /></span>
        </button>
        <div className="now-text">
          <div className="now-title">{track.title}</div>
          <div className="now-artist">
            {track.artistId ? <span className="link" onClick={() => open({ name: 'artist', id: track.artistId!, title: track.artist })}>{track.artist}</span> : track.artist}
          </div>
        </div>
        <button className={`row-like ${liked ? 'on' : ''}`} onClick={() => toggleLike(track)} aria-label="J’aime"><Icon name="heart" size={18} solid={liked} /></button>
        <button className="icon-button" onClick={(e) => showMenu(e, trackMenu(track))} aria-label="Plus"><Icon name="more" size={18} strokeWidth={3} /></button>
      </div>
      <div className="center">
        {state.error ? (
          <div className="player-error" onClick={() => state.source === 'octave' ? player.resume() : open({ name: 'settings' })}>
            <Icon name="radio" size={16} /> <span>{state.error}</span>
          </div>
        ) : null}
        <Controls />
        <Progress compact />
      </div>
      <div className="right">
        {supportsOctave && state.source && (
          <button className="badge source-selector" title="Changer la source de lecture" aria-haspopup="menu" onClick={(event) => showMenu(event, [
            { label: 'Lire avec Octave', icon: state.source === 'octave' ? 'check' : undefined, action: () => player.switchSource('octave') },
            { label: 'Lire avec YouTube Music', icon: state.source === 'youtube' ? 'check' : undefined, action: () => player.switchSource('youtube') },
            { label: '', separator: true },
            { label: 'Compte et réglages Octave', icon: 'settings', action: () => player.openOctave() },
          ])}>{state.source === 'octave' ? 'Octave' : 'YouTube Music'}</button>
        )}
        {state.ad && <button className="badge" onClick={() => void window.nova.invoke('webplayer:show', 0)}>Publicité YouTube</button>}
        {state.transitioning && <span className="badge"><Icon name="sparkles" size={14} /> {library.get().settings.transition === 'automix' ? 'AutoMix' : 'Fondu'}</span>}
        <button className={`icon-button ${jamState.role !== 'none' ? 'accent' : ''}`} onClick={() => open({ name: 'jam' })} aria-label="Jam"><Icon name="jam" size={19} /></button>
        <button className={`icon-button ${state.sleepAt ? 'accent' : ''}`} onClick={(e) => showMenu(e, sleepMenu())} aria-label="Minuterie"><Icon name="moon" size={18} /></button>
        <button className="icon-button" onClick={() => nowPlayingOpen.set('lyrics')} aria-label="Paroles"><Icon name="lyrics" size={19} /></button>
        <button className="icon-button" onClick={() => nowPlayingOpen.set('queue')} aria-label="File d’attente"><Icon name="list" size={19} /></button>
        {!isAndroid && <button className="icon-button" onClick={() => void window.nova.invoke('mini:open')} aria-label="Mini lecteur" title="Mini lecteur"><Icon name="mini" size={18} /></button>}
        <Volume />
      </div>
      {isAndroid && <MobileProgress />}
    </footer>
  );
}

// MARK: - Paroles

const lyricsCache = new Map<string, Lyrics | null>();

function useLyrics(track?: Track) {
  const { duration } = useStore(timeState);
  const [lyrics, setLyrics] = useState<Lyrics | null | undefined>(undefined);
  useEffect(() => {
    if (!track) return;
    if (lyricsCache.has(track.id)) return setLyrics(lyricsCache.get(track.id));
    setLyrics(undefined);
    let alive = true;
    void api.lyrics(track, duration || track.duration).then((found) => {
      lyricsCache.set(track.id, found ?? null);
      if (alive) setLyrics(found ?? null);
    }).catch(() => alive && setLyrics(null));
    return () => { alive = false; };
  }, [track?.id]);
  return lyrics;
}

function LyricsPanel({ track }: { track?: Track }) {
  const lyrics = useLyrics(track);
  const { time } = useStore(timeState);
  const container = useRef<HTMLDivElement>(null);
  const lines = lyrics?.lines ?? [];
  // Un peu en avance, comme dans Apple Music, pour lire la ligne au bon moment.
  let current = -1;
  for (let i = 0; i < lines.length && lines[i].time <= time + 0.3; i++) current = i;

  useEffect(() => {
    const element = container.current?.querySelector<HTMLElement>(`[data-line="${current}"]`);
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [current]);

  if (lyrics === undefined) return <div className="lyrics empty"><span className="spinner" /></div>;
  if (!lyrics) return <div className="lyrics empty"><Icon name="lyrics" size={40} /><p>Pas de paroles pour ce titre</p></div>;
  if (!lines.length) {
    return <div className="lyrics plain" ref={container}><p>{lyrics.text}</p>{lyrics.source && <small>{lyrics.source}</small>}</div>;
  }
  return (
    <div className="lyrics synced" ref={container}>
      {lines.map((line, i) => (
        <button key={i} data-line={i} className={`line ${i === current ? 'current' : ''} ${Math.abs(i - current) > 2 ? 'far' : ''}`}
          onClick={() => { player.seek(line.time); if (!playerState.get().playing) player.resume(); }}>
          {line.text || '• • •'}
        </button>
      ))}
      {lyrics.source && <small>{lyrics.source}</small>}
    </div>
  );
}

function QueuePanel() {
  const state = useStore(playerState);
  const upcoming = state.queue.map((track, position) => ({ track, position })).slice(state.index + 1, state.index + 101);
  const [dragged, setDragged] = useState<number | null>(null);
  return (
    <div className="queue">
      <h3>À suivre</h3>
      {!upcoming.length && <p className="muted">La file est vide : la lecture automatique enchaînera des titres similaires.</p>}
      {upcoming.map(({ track, position }) => (
        <div key={`${track.id}-${position}`} className="queue-row" draggable
          onDragStart={() => setDragged(position)} onDragOver={(e) => e.preventDefault()}
          onDrop={() => { if (dragged != null && dragged !== position) player.moveInQueue(dragged, position); setDragged(null); }}
          onDoubleClick={() => player.jumpTo(position)}
          onContextMenu={(e) => showMenu(e, trackMenu(track, [{ label: 'Retirer de la file', icon: 'trash', action: () => player.removeFromQueue(position) }]))}>
          <Artwork track={track} size={40} radius={5} />
          <div className="row-text"><div className="row-title">{track.title}</div><div className="row-subtitle">{track.artist}</div></div>
          {jam.get().state?.addedBy[track.id] && <span className="muted small">par {jam.get().state?.addedBy[track.id]}</span>}
          <button className="icon-button" onClick={() => player.removeFromQueue(position)} aria-label="Retirer"><Icon name="close" size={14} /></button>
        </div>
      ))}
    </div>
  );
}

export function NowPlaying() {
  const mode = useStore(nowPlayingOpen);
  const state = useStore(playerState);
  useStore(library);
  const track = state.queue[state.index];
  const background = useMemo(() => trackArtwork(track, 200), [track?.id, track?.artwork]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && nowPlayingOpen.set(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!mode || !track) return null;
  const liked = isLiked(track.id);
  return (
    <div className="now-playing">
      <div className="np-background" style={{ backgroundImage: background ? `url("${background}")` : undefined }} />
      <div className="np-titlebar">
        <button className="icon-button" onClick={() => nowPlayingOpen.set(false)} aria-label="Fermer"><Icon name="chevronDown" size={22} /></button>
        <div className="np-tabs">
          <button className={mode === 'artwork' ? 'on' : ''} onClick={() => nowPlayingOpen.set('artwork')}>Lecture</button>
          <button className={mode === 'lyrics' ? 'on' : ''} onClick={() => nowPlayingOpen.set('lyrics')}>Paroles</button>
          <button className={mode === 'queue' ? 'on' : ''} onClick={() => nowPlayingOpen.set('queue')}>À suivre</button>
        </div>
      </div>
      <div className={`np-body ${mode}`}>
        <div className="np-left">
          <div className="np-art">
            <Artwork track={track} size={mode === 'artwork' ? 440 : 340} radius={14} />
            {state.transitioning && <span className="badge floating"><Icon name="sparkles" size={14} /> {library.get().settings.transition === 'automix' ? 'AutoMix' : 'Fondu enchaîné'}</span>}
          </div>
          <div className="np-meta">
            <div>
              <h1>{track.title}</h1>
              <p className="link" onClick={() => { if (track.artistId) { nowPlayingOpen.set(false); open({ name: 'artist', id: track.artistId, title: track.artist }); } }}>{track.artist}</p>
            </div>
            <button className={`round-button ${liked ? 'on' : ''}`} onClick={() => toggleLike(track)} aria-label="J’aime"><Icon name="heart" size={20} solid={liked} /></button>
            <button className="round-button" onClick={(e) => showMenu(e, trackMenu(track))} aria-label="Plus"><Icon name="more" size={20} strokeWidth={3} /></button>
          </div>
          <Progress />
          <Controls large />
          <Volume />
        </div>
        {mode !== 'artwork' && <div className="np-right">{mode === 'lyrics' ? <LyricsPanel track={track} /> : <QueuePanel />}</div>}
      </div>
    </div>
  );
}

export { currentTrack };
