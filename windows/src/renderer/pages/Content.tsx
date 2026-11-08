// Pages d'artiste, d'album et de playlist YouTube Music.
import type { Collection } from '../../shared/types';
import { Artwork } from '../components/Artwork';
import { Icon } from '../components/icons';
import { ShelfView } from '../components/Shelf';
import { api } from '../lib/api';
import { isSaved, isShared, library, sharedURL, toggleSaved, upsertPlaylist, notify } from '../lib/library';
import { player } from '../lib/player';
import { open } from '../lib/router';
import { useStore } from '../lib/store';
import { ErrorState, Loading, PlayShuffle, SortButton, TrackList, sortOrder, useCached, useTrackSort } from './common';

export function ArtistPage({ id, title }: { id: string; title: string }) {
  useStore(library);
  const { data, error, loading, reload } = useCached(`artist-${id}`, () => api.artist(id), 30 * 60_000);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState message={error} retry={() => reload(true)} />;
  if (!data) return null;
  const name = data.header.title || title;
  const collection: Collection = { id, kind: 'artist', title: name, artwork: data.header.artwork };
  const playAll = async (shuffle: boolean) => {
    const songs = await api.artistSongs(id).catch(() => []);
    player.play(songs.length ? songs : data.tracks, 0, shuffle);
  };
  return (
    <div className="page artist-page">
      <div className="artist-banner" style={{ backgroundImage: data.header.artwork ? `url("${data.header.artwork.replace(/=w\d+-h\d+/, '=w1400-h1400')}")` : undefined }}>
        <div className="artist-banner-content">
          <h1>{name}</h1>
          <div className="row-buttons">
            <button className="button" onClick={() => void playAll(false)}><Icon name="play" size={16} /> Lecture</button>
            <button className="button secondary" onClick={() => void playAll(true)}><Icon name="shuffle" size={16} /> Aléatoire</button>
            {data.tracks[0] && <button className="button secondary" onClick={() => player.startRadio(data.tracks[0])}><Icon name="radio" size={16} /> Radio</button>}
            <button className="button secondary" onClick={() => toggleSaved(collection)}>
              <Icon name={isSaved(id) ? 'check' : 'plus'} size={16} /> {isSaved(id) ? 'Suivi' : 'Suivre'}
            </button>
            <button className="button secondary" onClick={() => open({ name: 'concerts', artist: name })}><Icon name="ticket" size={16} /> Concerts</button>
          </div>
        </div>
      </div>
      {data.header.description && <p className="artist-description">{data.header.description}</p>}
      {data.shelves.map((shelf) => <ShelfView key={shelf.id} shelf={shelf} limit={5} />)}
    </div>
  );
}

export function CollectionPage({ collection }: { collection: Collection }) {
  const state = useStore(library);
  const sort = useTrackSort(`collection.${collection.id}`);
  // Playlist partagée : d'autres y ajoutent des titres, elle est relue à chaque ouverture.
  const shared = isShared(collection.id);
  const { data, error, loading, reload } = useCached(`collection-${collection.id}`, () => api.collection(collection), shared ? 0 : 30 * 60_000);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState message={error} retry={() => reload(true)} />;
  if (!data) return null;
  const header = data.header;
  const isAlbum = collection.kind === 'album';
  const tracks = sortOrder(data.tracks, sort.sort, sort.reversed, state.stats).map((i) => data.tracks[i]);
  const saved: Collection = { ...collection, title: header.title || collection.title, artwork: header.artwork ?? collection.artwork, subtitle: header.subtitle ?? collection.subtitle };
  return (
    <div className="page">
      <div className="collection-header">
        <Artwork url={header.artwork ?? collection.artwork} size={240} radius={12} />
        <div className="collection-info">
          <p className="eyebrow">{isAlbum ? 'Album' : 'Playlist'}</p>
          <h1>{header.title || collection.title}</h1>
          {header.subtitle && <p className="muted">{header.subtitle}</p>}
          {header.description && <p className="description">{header.description}</p>}
          <div className="row-buttons">
            <PlayShuffle tracks={tracks} />
            <SortButton state={sort} manualLabel={isAlbum ? 'Ordre de l’album' : 'Ordre de la playlist'} />
            <button className="button secondary" onClick={() => toggleSaved(saved)}>
              <Icon name={isSaved(collection.id) ? 'check' : 'plus'} size={16} /> {isSaved(collection.id) ? 'Dans la bibliothèque' : 'Ajouter'}
            </button>
            {!isAlbum && (
              <button className="button secondary" onClick={() => { upsertPlaylist(saved.title, data.tracks); notify('Copiée dans tes playlists'); }}>
                <Icon name="list" size={16} /> Copier
              </button>
            )}
          </div>
        </div>
      </div>
      {shared && (
        <div className="shared-banner">
          <Icon name="jam" size={20} />
          <div>
            <strong>Playlist partagée</strong>
            <p className="muted small">Pour inviter des amis : ouvre-la dans YouTube Music → « ⋯ » → « Collaborer », active la collaboration et envoie le lien
              d’invitation. Eux : Nova → Playlists partagées → « Rejoindre avec un lien ». Chacun ajoute ensuite des titres depuis Nova.</p>
          </div>
          <button className="button secondary" onClick={() => void api.openYouTube(sharedURL(collection.id.replace(/^VL/, '')))}>Ouvrir dans YouTube Music</button>
          <button className="button secondary" onClick={() => void reload(true)}>Actualiser</button>
        </div>
      )}
      <TrackList tracks={tracks} numbered={isAlbum && sort.manual} />
      {data.related.map((shelf) => <ShelfView key={shelf.id} shelf={shelf} />)}
    </div>
  );
}
