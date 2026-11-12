import { useState } from 'react';
import { TrackRow } from '../components/TrackRow';
import { library } from '../lib/library';
import { player } from '../lib/player';
import { useStore } from '../lib/store';
import { Empty, PageTitle } from './common';

const countLabel = (count: number, noun: string) => `${count.toLocaleString('fr-FR')} ${noun}${count > 1 ? 's' : ''}`;

export function WrappedPage() {
  const { listeningYears = {} } = useStore(library);
  const currentYear = String(new Date().getFullYear());
  const [year, setYear] = useState(currentYear);
  const years = [...new Set([currentYear, ...Object.keys(listeningYears)])].sort().reverse();
  const tracks = Object.values(listeningYears[year] ?? {}).sort((a, b) => b.plays - a.plays);
  const artists = new Map<string, number>();
  let total = 0;
  for (const { track, plays } of tracks) {
    total += plays;
    if (track.artist) artists.set(track.artist, (artists.get(track.artist) ?? 0) + plays);
  }
  const topArtists = [...artists].sort((a, b) => b[1] - a[1]).slice(0, 10);

  return (
    <div className="page">
      <PageTitle actions={(
        <select aria-label="Année du récap" value={year} onChange={(event) => setYear(event.target.value)}>
          {years.map((value) => <option key={value}>{value}</option>)}
        </select>
      )}>Récap {year}</PageTitle>
      <p className="muted">Les écoutes enregistrées dans Nova depuis la mise à jour alimentent ton récap.</p>
      {!total ? (
        <Empty icon="sparkles" title="Aucune écoute pour cette année" text="Les morceaux que tu écoutes dans Nova apparaîtront ici." />
      ) : <>
        <p>{countLabel(total, 'écoute')} · {countLabel(tracks.length, 'titre')} · {countLabel(artists.size, 'artiste')}</p>
        <section className="shelf">
          <header className="shelf-header"><h2>Titres les plus écoutés</h2></header>
          <ol>
            {tracks.slice(0, 10).map(({ track, plays }) => (
              <li key={track.id}>
                <TrackRow track={track} onPlay={() => player.play([track])} />
                <span className="muted">{countLabel(plays, 'écoute')}</span>
              </li>
            ))}
          </ol>
        </section>
        {topArtists.length > 0 && <section className="shelf">
          <header className="shelf-header"><h2>Artistes les plus écoutés</h2></header>
          <ol>{topArtists.map(([artist, plays]) => <li key={artist}>{artist} <span className="muted">· {countLabel(plays, 'écoute')}</span></li>)}</ol>
        </section>}
      </>}
    </div>
  );
}
