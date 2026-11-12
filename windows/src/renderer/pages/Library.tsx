// Bibliothèque : playlists, morceaux, titres likés, historique, albums, ajouts récents, playlists intelligentes.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Item, SmartField, SmartOperator, SmartPlaylist, SmartRule, Track } from '../../shared/types';
import { Artwork } from '../components/Artwork';
import { Icon } from '../components/icons';
import { ask } from '../components/menus';
import { CardGrid } from '../components/Shelf';
import { TrackRow } from '../components/TrackRow';
import {
  account, clearRecents, deletePlaylist, deleteSmartPlaylist, library, moveInPlaylist, notify, refreshAccount,
  removeFromPlaylist, removeRecent, renamePlaylist, saveSmartPlaylist, smartTracks, songs, verifyPlaylistOnOctave,
} from '../lib/library';
import { player } from '../lib/player';
import { open, root } from '../lib/router';
import { libraryGroups, recentLibraryEntries, releaseType, type LibraryGroup, type LibraryGroupKind } from '../lib/libraryGroups';
import { useStore } from '../lib/store';
import { Empty, PageTitle, PlayShuffle, SortButton, TrackList, sortOrder, useTrackSort } from './common';

export function UserPlaylistPage({ id }: { id: string }) {
  const state = useStore(library);
  const [dragged, setDragged] = useState<number | null>(null);
  const [verification, setVerification] = useState<string>();
  const sort = useTrackSort(`playlist.${id}`);
  const playlist = state.playlists.find((p) => p.id === id);
  if (!playlist) return <Empty icon="list" title="Playlist introuvable" />;
  const order = sortOrder(playlist.tracks, sort.sort, sort.reversed, state.stats);
  const shown = order.map((i) => playlist.tracks[i]);
  return (
    <div className="page">
      <div className="collection-header">
        <Artwork track={playlist.tracks[0]} size={240} radius={12} />
        <div className="collection-info">
          <p className="eyebrow">Playlist{playlist.youtubeId ? ' · synchronisée avec YouTube' : ''}</p>
          <h1>{playlist.name}</h1>
          <div className="row-buttons">
            <PlayShuffle tracks={shown} playlist playlistId={id} />
            <SortButton state={sort} />
            <button className="button secondary" disabled={!!verification || !playlist.tracks.length} onClick={() => {
              setVerification('Vérification…');
              void verifyPlaylistOnOctave(id, (done, total) => setVerification(done + ' / ' + total))
                .then(count => notify(count ? count + ' correspondances Octave corrigées' : 'Aucune nouvelle correspondance Octave'))
                .catch(() => notify('Vérification impossible'))
                .finally(() => setVerification(undefined));
            }}>{verification ?? 'Vérifier sur Octave'}</button>
            <button className="button secondary" onClick={async () => {
              const name = await ask('Renommer la playlist', playlist.name, 'Renommer');
              if (name) renamePlaylist(playlist.id, name);
            }}>Renommer</button>
            <button className="button secondary danger" onClick={() => { deletePlaylist(playlist.id); notify('Playlist supprimée'); root({ name: 'home' }); }}>
              <Icon name="trash" size={16} /> Supprimer
            </button>
          </div>
        </div>
      </div>
      {!playlist.tracks.length && <p className="muted">Ajoute des titres avec le menu « … » d’un titre, puis « Ajouter à une playlist ».</p>}
      <div className="track-list">
        {shown.map((track, i) => (
          <div key={`${track.id}-${order[i]}`} draggable={sort.manual} onDragStart={() => setDragged(i)} onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (sort.manual && dragged != null && dragged !== i) moveInPlaylist(playlist.id, dragged, i); setDragged(null); }}>
            <TrackRow track={track} index={i} onPlay={() => player.playPlaylist(shown, i, false, id)}
              extraMenu={[{ label: '', separator: true }, { label: 'Retirer de la playlist', icon: 'trash', danger: true, action: () => removeFromPlaylist(playlist.id, track.id) }]} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function SongsPage() {
  const state = useStore(library);
  const [filter, setFilter] = useState('');
  const all = useMemo(() => songs(state), [state.playlists, state.liked]);
  const shown = filter ? all.filter((t) => `${t.title} ${t.artist} ${t.album ?? ''}`.toLowerCase().includes(filter.toLowerCase())) : all;
  return (
    <div className="page">
      <PageTitle actions={<input className="filter" placeholder="Filtrer" value={filter} onChange={(e) => setFilter(e.target.value)} />}>Morceaux</PageTitle>
      <PlayShuffle tracks={shown} />
      {all.length ? <TrackList tracks={shown} /> : <Empty icon="music" title="Aucun morceau" text="Les titres likés et ceux de tes playlists apparaissent ici, sans doublons." />}
    </div>
  );
}

export function LikedPage() {
  const state = useStore(library);
  const user = useStore(account);
  const sort = useTrackSort('liked');
  const shown = sortOrder(state.liked, sort.sort, sort.reversed, state.stats).map((i) => state.liked[i]);
  return (
    <div className="page">
      <PageTitle actions={user.signedIn && <button className="button secondary" onClick={() => void refreshAccount().then(() => notify('Likes synchronisés'))}>Synchroniser</button>}>
        Titres likés
      </PageTitle>
      <div className="row-buttons"><PlayShuffle tracks={shown} /><SortButton state={sort} manualLabel="Derniers likés" /></div>
      {state.liked.length ? <TrackList tracks={shown} />
        : <Empty icon="heart" title="Aucun titre liké" text="Clique sur le cœur d’un titre. Connecté à YouTube, tes likes sont les mêmes que sur l’iPhone." />}
    </div>
  );
}

function dayTitle(timestamp?: number) {
  if (!timestamp) return 'Plus ancien';
  const date = new Date(timestamp), today = new Date();
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(today) - start(date)) / 86_400_000);
  if (days === 0) return 'Aujourd’hui';
  if (days === 1) return 'Hier';
  const text = date.toLocaleDateString('fr-FR', days < 7 ? { weekday: 'long' } : { weekday: 'long', day: 'numeric', month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function HistoryPage() {
  const state = useStore(library);
  const [filter, setFilter] = useState('');
  const shown = filter ? state.recents.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(filter.toLowerCase())) : state.recents;
  const days: { title: string; tracks: Track[] }[] = [];
  for (const track of shown) {
    const title = dayTitle(state.stats[track.id]?.lastPlayed);
    if (days.at(-1)?.title === title) days.at(-1)!.tracks.push(track);
    else days.push({ title, tracks: [track] });
  }
  return (
    <div className="page">
      <PageTitle actions={<>
        <input className="filter" placeholder="Rechercher dans l’historique" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {(state.recents.length > 0 || Object.keys(state.listeningYears ?? {}).length > 0) && <button className="button secondary"
          onClick={() => { if (confirm('Effacer tout l’historique et les données du récap annuel ?')) clearRecents(); }}>Effacer</button>}
      </>}>Historique</PageTitle>
      <PlayShuffle tracks={shown} />
      {!state.recents.length && <Empty icon="clock" title="Historique vide" text="Les titres que tu écoutes apparaîtront ici." />}
      {days.map((day) => (
        <section key={day.title} className="history-day">
          <h3>{day.title}</h3>
          {day.tracks.map((track) => (
            <TrackRow key={track.id} track={track} onPlay={() => player.play(shown, shown.indexOf(track))}
              extraMenu={[{ label: '', separator: true }, { label: 'Retirer de l’historique', icon: 'trash', action: () => removeRecent(track.id) }]} />
          ))}
        </section>
      ))}
      <p className="muted list-footer">{shown.length} titres écoutés</p>
    </div>
  );
}

function GroupCards({ groups, kind }: { groups: LibraryGroup[]; kind: LibraryGroupKind }) {
  return <div className="card-grid">
    {groups.map(group => <GroupCard key={group.id} group={group} kind={kind} />)}
  </div>;
}

function GroupCard({ group, kind }: { group: LibraryGroup; kind: LibraryGroupKind }) {
  return <button className="library-group-card"
      onClick={() => open({ name: 'libraryGroup', kind, id: group.id })}>
      <Artwork track={group.artworkTrack} size={176} radius={12} round={kind === 'artist'} />
      <span className="card-title">{group.title}</span>
      <span className="card-subtitle">{kind === 'artist' ? group.tracks.length + ' titres' : group.subtitle + ' · ' + releaseType(group)}</span>
    </button>;
}

export function AlbumsPage({ kind = 'album' }: { kind?: LibraryGroupKind }) {
  const state = useStore(library);
  const groups = useMemo(() => libraryGroups(state, kind), [state, kind]);
  const [limit, setLimit] = useState(80);
  const [query, setQuery] = useState('');
  const visible = groups.filter(group => (group.title + ' ' + group.subtitle).toLocaleLowerCase('fr').includes(query.trim().toLocaleLowerCase('fr')));
  const known = new Set(groups.flatMap(group => group.tracks.map(track => kind === 'artist' ? track.artistId : track.albumId)));
  const items: Item[] = state.saved.filter(collection => collection.kind === kind && !known.has(collection.id)).map(collection => ({ type: 'collection', collection }));
  return (
    <div className="page">
      <PageTitle>{kind === 'artist' ? 'Artistes' : 'Albums'}</PageTitle>
      {groups.length > 0 && <label className="field library-group-search">Filtrer
        <input type="search" value={query} onChange={event => { setQuery(event.target.value); setLimit(80); }} />
      </label>}
      <GroupCards groups={visible.slice(0, limit)} kind={kind} />
      {visible.length > limit && <button className="button secondary" onClick={() => setLimit(limit + 80)}>Afficher la suite</button>}
      {items.length > 0 && !query && <section className="shelf"><header className="shelf-header"><h2>Enregistrés</h2></header><CardGrid items={items} /></section>}
      {!visible.length && (!items.length || query) && <Empty icon={kind === 'artist' ? 'mic' : 'album'} title={query ? 'Aucun résultat' : 'Rien pour l’instant'} />}
    </div>
  );
}

export function LibraryGroupPage({ id, kind }: { id: string; kind: LibraryGroupKind }) {
  const state = useStore(library);
  const group = useMemo(() => libraryGroups(state, kind, true).find(group => group.id === id), [state, kind, id]);
  if (!group) return <Empty icon="album" title="Sortie introuvable" />;
  const catalogID = kind === 'album' ? group.tracks.find(track => track.albumId)?.albumId : group.tracks.find(track => track.artistId)?.artistId;
  return <div className="page">
    <div className="collection-header">
      <Artwork track={group.artworkTrack} size={200} radius={14} round={kind === 'artist'} />
      <div className="collection-info">
        <p className="eyebrow">{kind === 'artist' ? 'Artiste' : releaseType(group)}</p>
        <h1>{group.title}</h1>
        {group.subtitle && <p className="muted">{group.subtitle}</p>}
        <div className="row-buttons">
          <PlayShuffle tracks={group.tracks} />
          {catalogID && <button className="button secondary" onClick={() => open(kind === 'artist'
            ? { name: 'artist', id: catalogID, title: group.title }
            : { name: 'collection', collection: { id: catalogID, kind: 'album', title: group.title, subtitle: group.subtitle } })}>Voir dans le catalogue</button>}
        </div>
      </div>
    </div>
    <TrackList tracks={group.tracks} />
  </div>;
}

export function RecentPage() {
  const state = useStore(library);
  const [limit, setLimit] = useState(60);
  const sentinel = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => recentLibraryEntries(state), [state.playlists, state.liked, state.added, state.saved, state.stats]);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || limit >= entries.length) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setLimit(current => Math.min(current + 60, entries.length));
    }, { rootMargin: '480px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [limit, entries.length]);
  return (
    <div className="page">
      <PageTitle>Ajouts récents</PageTitle>
      {entries.length ? <div className="card-grid">
        {entries.slice(0, limit).map(entry => entry.kind === 'group'
          ? <GroupCard key={'group:' + entry.group.id} group={entry.group} kind="album" />
          : <button key={'album:' + entry.album.id} className="library-group-card"
            onClick={() => open({ name: 'collection', collection: entry.album })}>
            <Artwork track={{ id: entry.album.id, title: entry.title, artist: entry.album.subtitle ?? '', artwork: entry.album.artwork, square: true }}
              size={176} radius={12} />
            <span className="card-title">{entry.title}</span>
            <span className="card-subtitle">{[entry.album.subtitle, 'Album'].filter(Boolean).join(' · ')}</span>
          </button>)}
      </div> : <Empty icon="clock" title="Rien d’ajouté récemment" />}
      {entries.length > limit && <div ref={sentinel} aria-hidden="true" style={{ height: 1 }} />}
    </div>
  );
}

export function YouTubePlaylistsPage() {
  const user = useStore(account);
  return (
    <div className="page">
      <PageTitle actions={<button className="button secondary" onClick={() => void refreshAccount()}>Actualiser</button>}>Playlists YouTube</PageTitle>
      <p className="muted">Les playlists de ton compte YouTube Music : les mêmes que sur l’iPhone.</p>
      <CardGrid items={user.playlists.map((collection) => ({ type: 'collection', collection }))} />
    </div>
  );
}

// MARK: Playlists intelligentes

const fields: [SmartField, string][] = [['artist', 'Artiste'], ['title', 'Titre'], ['album', 'Album'], ['playCount', 'Nombre d’écoutes'], ['lastPlayed', 'Dernière écoute'], ['liked', 'J’aime']];
const operators: Record<SmartField, [SmartOperator, string][]> = {
  artist: [['contains', 'contient'], ['is', 'est'], ['not', 'ne contient pas']],
  title: [['contains', 'contient'], ['is', 'est'], ['not', 'ne contient pas']],
  album: [['contains', 'contient'], ['is', 'est'], ['not', 'ne contient pas']],
  playCount: [['greater', 'est supérieur à'], ['less', 'est inférieur à'], ['is', 'est']],
  lastPlayed: [['inLast', 'dans les derniers (jours)'], ['notInLast', 'pas dans les derniers (jours)']],
  liked: [['is', 'oui'], ['not', 'non']],
};

export function newSmartPlaylist(): SmartPlaylist {
  return { id: crypto.randomUUID(), name: 'Playlist intelligente', rules: [{ field: 'playCount', operator: 'greater', value: '3' }], matchAll: true, limit: 50, sort: 'mostPlayed' };
}

export function SmartPlaylistPage({ id }: { id: string }) {
  const state = useStore(library);
  const playlist = state.smartPlaylists?.find((p) => p.id === id);
  const [editing, setEditing] = useState(false);
  const tracks = useMemo(() => (playlist ? smartTracks(playlist, state) : []), [playlist, state.stats, state.liked, state.playlists]);
  if (!playlist) return <Empty icon="smart" title="Playlist introuvable" />;
  const change = (next: Partial<SmartPlaylist>) => saveSmartPlaylist({ ...playlist, ...next });
  const changeRule = (index: number, rule: Partial<SmartRule>) => change({ rules: playlist.rules.map((r, i) => (i === index ? { ...r, ...rule } : r)) });
  return (
    <div className="page">
      <PageTitle actions={<>
        <button className="button secondary" onClick={() => setEditing(!editing)}>{editing ? 'Terminé' : 'Modifier les règles'}</button>
        <button className="button secondary danger" onClick={() => { deleteSmartPlaylist(playlist.id); root({ name: 'home' }); }}><Icon name="trash" size={16} /></button>
      </>}>{playlist.name}</PageTitle>
      {editing && (
        <div className="smart-editor">
          <label>Nom <input value={playlist.name} onChange={(e) => change({ name: e.target.value })} /></label>
          <label>Correspond à
            <select value={playlist.matchAll ? 'all' : 'any'} onChange={(e) => change({ matchAll: e.target.value === 'all' })}>
              <option value="all">toutes les règles</option><option value="any">au moins une règle</option>
            </select>
          </label>
          {playlist.rules.map((rule, i) => (
            <div key={i} className="smart-rule">
              <select value={rule.field} onChange={(e) => { const field = e.target.value as SmartField; changeRule(i, { field, operator: operators[field][0][0] }); }}>
                {fields.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select value={rule.operator} onChange={(e) => changeRule(i, { operator: e.target.value as SmartOperator })}>
                {operators[rule.field].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              {rule.field !== 'liked' && <input value={rule.value} onChange={(e) => changeRule(i, { value: e.target.value })} />}
              <button className="icon-button" onClick={() => change({ rules: playlist.rules.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>
            </div>
          ))}
          <button className="text-button" onClick={() => change({ rules: [...playlist.rules, { field: 'artist', operator: 'contains', value: '' }] })}>+ Ajouter une règle</button>
          <label>Trier par
            <select value={playlist.sort} onChange={(e) => change({ sort: e.target.value as SmartPlaylist['sort'] })}>
              <option value="mostPlayed">les plus écoutés</option><option value="recent">écoutés récemment</option>
              <option value="title">titre</option><option value="random">au hasard</option>
            </select>
          </label>
          <label>Limiter à <input type="number" min={0} value={playlist.limit ?? 0} onChange={(e) => change({ limit: Number(e.target.value) || undefined })} /> titres</label>
        </div>
      )}
      <PlayShuffle tracks={tracks} playlist />
      {tracks.length ? <TrackList tracks={tracks} playlist /> : <p className="muted">Aucun titre ne correspond aux règles pour l’instant.</p>}
    </div>
  );
}
