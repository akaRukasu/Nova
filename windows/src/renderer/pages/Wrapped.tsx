import { useState } from 'react';
import type { Track } from '../../shared/types';
import { Artwork } from '../components/Artwork';
import { Icon } from '../components/icons';
import { TrackRow } from '../components/TrackRow';
import { library } from '../lib/library';
import { player } from '../lib/player';
import { useStore } from '../lib/store';
import { Empty } from './common';

type Rank = { name: string; track: Track; plays: number };
const number = (value: number) => value.toLocaleString('fr-FR');

function Ranking({ title, entries }: { title: string; entries: Rank[] }) {
  if (!entries.length) return null;
  return <section className="recap-panel">
    <h2>{title}</h2>
    <ol className="recap-ranking">
      {entries.slice(0, 8).map(({ name, track, plays }, index) => <li key={name}>
        <span className="recap-rank">{index + 1}</span>
        <Artwork track={track} size={42} radius={8} />
        <div className="recap-rank-label"><strong>{name}</strong>
          <meter min={0} max={entries[0].plays} value={plays} aria-label={'Écoutes de ' + name} />
        </div>
        <b>{number(plays)}</b>
      </li>)}
    </ol>
  </section>;
}

export function WrappedPage() {
  const { listeningYears = {} } = useStore(library);
  const currentYear = String(new Date().getFullYear());
  const [year, setYear] = useState(currentYear);
  const years = [...new Set([currentYear, ...Object.keys(listeningYears)])].sort().reverse();
  const tracks = Object.values(listeningYears[year] ?? {}).sort((a, b) => b.plays - a.plays || a.track.title.localeCompare(b.track.title, 'fr'));
  const artists = new Map<string, Rank>();
  const albums = new Map<string, Rank>();
  let total = 0;
  let seconds = 0;
  const add = (ranks: Map<string, Rank>, key: string, name: string, track: Track, plays: number) => {
    if (!name.trim()) return;
    const previous = ranks.get(key);
    ranks.set(key, { name, track: previous?.track ?? track, plays: (previous?.plays ?? 0) + plays });
  };
  for (const { track, plays } of tracks) {
    total += plays;
    seconds += plays * (track.duration ?? 0);
    add(artists, track.artist.toLocaleLowerCase('fr'), track.artist, track, plays);
    if (track.album) add(albums, (track.album + '|' + track.artist).toLocaleLowerCase('fr'), track.album + ' · ' + track.artist, track, plays);
  }
  const top = tracks[0]?.track;
  const ranking = (entries: Map<string, Rank>) => [...entries.values()].sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name, 'fr'));
  const metrics = [[total, 'Écoutes'], [tracks.length, 'Titres différents'], [artists.size, 'Artistes'], [albums.size, 'Albums']] as const;
  return <div className="page recap-page">
    <header className="recap-hero">
      <div>
        <p className="recap-year"><Icon name="sparkles" size={16} /> Récap annuel</p>
        <h1>Mon année en musique</h1>
        <label className="recap-select"><span>Année</span><select aria-label="Année du récap" value={year} onChange={e => setYear(e.target.value)}>
          {years.map(value => <option key={value}>{value}</option>)}
        </select></label>
        {top && <div className="recap-top"><p>Ton titre le plus écouté</p><strong>{top.title}</strong><span>{top.artist}</span></div>}
        {top && <button className="button recap-play" onClick={() => player.play(tracks.slice(0, 50).map(entry => entry.track))}>
          <Icon name="play" size={17} /> Écouter mon top
        </button>}
      </div>
      {top && <Artwork track={top} size={208} radius={19} className="recap-hero-cover" />}
    </header>
    {!total ? <Empty icon="sparkles" title="Aucune écoute pour cette année" text="Les écoutes enregistrées dans Nova apparaîtront ici." /> : <>
      <div className="recap-metrics">{metrics.map(([value, label]) => <div key={label}><strong>{number(value)}</strong><span>{label}</span></div>)}</div>
      {seconds > 0 && <p className="muted small recap-estimate">{number(Math.round(seconds / 60))} min estimées à partir de la durée des titres et du nombre d’écoutes.</p>}
      <div className="recap-pair">
        <Ranking title="Artistes en tête" entries={ranking(artists)} />
        <Ranking title="Albums en tête" entries={ranking(albums)} />
      </div>
      <section className="recap-panel">
        <h2>Les titres que tu as le plus écoutés</h2>
        <ol className="recap-tracks">
          {tracks.slice(0, 20).map(({ track, plays }, index) => <li key={track.id}>
            <TrackRow track={track} rank={index} onPlay={() => player.play([track])} />
            <span>{number(plays)} {plays === 1 ? 'écoute' : 'écoutes'}</span>
          </li>)}
        </ol>
      </section>
    </>}
  </div>;
}
