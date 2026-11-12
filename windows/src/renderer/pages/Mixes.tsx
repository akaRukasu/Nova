// Mix sur mesure, comme sur Apple Music : favoris, découverte, redécouverte, mix du jour.
import { useEffect, useState } from 'react';
import type { Track } from '../../shared/types';
import { Artwork } from '../components/Artwork';
import { Icon } from '../components/icons';
import { api } from '../lib/api';
import { createPlaylist, dedupe, library, notify, shuffle, songs } from '../lib/library';
import { player } from '../lib/player';
import { open } from '../lib/router';
import { Loading, PlayShuffle, TrackList } from './common';

export interface MixKind {
  id: string;
  title: string;
  subtitle: string;
  colors: [string, string];
}

const all: MixKind[] = [
  { id: 'daily', title: 'Mix du jour', subtitle: 'Tes titres du moment et des proches, renouvelé chaque jour', colors: ['#fa2d55', '#7a1636'] },
  { id: 'discovery', title: 'Mix découverte', subtitle: 'Des titres que tu n’as jamais écoutés, d’après tes goûts', colors: ['#6e56cf', '#1f1a4d'] },
  { id: 'favorites', title: 'Mix favoris', subtitle: 'Tes titres les plus écoutés et ceux que tu aimes', colors: ['#f76b15', '#7a2e05'] },
  { id: 'rediscovery', title: 'Redécouverte', subtitle: 'Des titres aimés que tu n’as pas écoutés depuis longtemps', colors: ['#12a594', '#07443d'] },
];

export function mixKinds(): MixKind[] {
  const state = library.get();
  if (state.recents.length + state.liked.length < 5) return [];
  return all;
}

function topTracks(): Track[] {
  const state = library.get();
  return dedupe([...state.recents, ...state.liked]).sort((a, b) => (state.stats[b.id]?.playCount ?? 0) - (state.stats[a.id]?.playCount ?? 0));
}

function previews(kind: MixKind): Track[] {
  const top = topTracks();
  if (kind.id === 'rediscovery') return songs().slice(0, 4);
  return top.slice(kind.id === 'discovery' ? 4 : 0, (kind.id === 'discovery' ? 4 : 0) + 4);
}

/** Graine stable sur la journée : le mix ne change pas à chaque visite. */
function daySeed() {
  const date = new Date();
  return date.getFullYear() * 1000 + date.getMonth() * 40 + date.getDate();
}

async function build(kind: MixKind): Promise<Track[]> {
  const state = library.get();
  const top = topTracks();
  const known = new Set([...state.recents, ...state.liked, ...songs()].map((t) => t.id));
  const radios = async (seeds: Track[], count: number, onlyNew: boolean) => {
    const lists = await Promise.all(seeds.map((s) => api.radio(s.id).catch(() => [] as Track[])));
    return lists.flatMap((l) => l.slice(1, count + 1)).filter((t) => !onlyNew || !known.has(t.id));
  };
  switch (kind.id) {
    case 'favorites':
      return shuffle(dedupe([...top.slice(0, 40), ...state.liked.slice(0, 40)])).slice(0, 50);
    case 'discovery': {
      const seen = new Set<string>();
      const seeds = top.filter((t) => !seen.has(t.artist) && !!seen.add(t.artist)).slice(0, 6);
      return shuffle(dedupe(await radios(seeds, 12, true))).slice(0, 50);
    }
    case 'rediscovery': {
      const month = Date.now() - 30 * 86_400_000;
      return shuffle(songs().filter((t) => (state.stats[t.id]?.lastPlayed ?? 0) < month)).slice(0, 50);
    }
    default: {
      const seed = daySeed();
      const rotated = top.slice(0, 30).sort((a, b) => ((a.id.charCodeAt(0) * seed) % 97) - ((b.id.charCodeAt(0) * seed) % 97));
      const near = await radios(rotated.slice(0, 3), 8, false);
      return dedupe([...rotated.slice(0, 15), ...near]).sort(() => 0.5 - Math.random()).slice(0, 50);
    }
  }
}

export function MixCard({ kind }: { kind: MixKind }) {
  const tracks = previews(kind);
  return (
    <button className="mix-card" style={{ background: `linear-gradient(135deg, ${kind.colors[0]}, ${kind.colors[1]})` }}
      onClick={() => open({ name: 'mix', kind: kind.id })}>
      <div className="mix-mosaic">{tracks.map((t) => <Artwork key={t.id} track={t} size={88} radius={0} />)}</div>
      <div className="mix-label"><strong>{kind.title}</strong></div>
    </button>
  );
}

export function MixPage({ kindId }: { kindId: string }) {
  const kind = all.find((k) => k.id === kindId) ?? all[0];
  const [tracks, setTracks] = useState<Track[] | null>(null);
  useEffect(() => {
    setTracks(null);
    void build(kind).then(setTracks).catch(() => setTracks([]));
  }, [kind.id]);
  return (
    <div className="page">
      <div className="mix-switcher">{all.map((k) => (
        <button key={k.id} className={`chip ${k.id === kind.id ? 'on' : ''}`} onClick={() => open({ name: 'mix', kind: k.id })}>{k.title}</button>
      ))}</div>
      <div className="collection-header">
        <div className="mix-card large" style={{ background: `linear-gradient(135deg, ${kind.colors[0]}, ${kind.colors[1]})` }}>
          <div className="mix-label"><small>NOVA</small><strong>{kind.title}</strong></div>
        </div>
        <div className="collection-info">
          <p className="eyebrow">Mix</p>
          <h1>{kind.title}</h1>
          <p className="muted">{kind.subtitle}</p>
          <div className="row-buttons">
            <PlayShuffle tracks={tracks ?? []} />
            <button className="button secondary" disabled={!tracks?.length} onClick={() => {
              createPlaylist(`${kind.title} – ${new Date().toLocaleDateString('fr-FR')}`, tracks ?? []);
              notify('Mix enregistré comme playlist');
            }}><Icon name="plus" size={16} /> Enregistrer</button>
          </div>
        </div>
      </div>
      {!tracks ? <Loading /> : tracks.length ? <TrackList tracks={tracks} /> : (
        <p className="muted">Écoute et aime quelques titres de plus : ce mix se remplira tout seul.</p>
      )}
      {tracks && tracks.length > 0 && <button className="text-button"
        onClick={() => player.play(tracks, 0, true)}>Lire en aléatoire</button>}
    </div>
  );
}
