import type { Collection, Track } from '../../shared/types';
import { api } from './api';
import { notify } from './library';
import { open } from './router';

export async function openTrackCatalog(track: Track, kind: 'album' | 'artist') {
  const navigate = (collection: Collection) => kind === 'artist'
    ? open({ name: 'artist', id: collection.id, title: collection.title })
    : open({ name: 'collection', collection });
  const known = kind === 'album' ? track.albumId : track.artistId;
  if (known) { navigate({ id: known, kind, title: kind === 'album' ? track.album ?? track.title : track.artist }); return; }
  notify('Recherche dans le catalogue…');
  try {
    const matched = await api.octaveMatch(track.id.startsWith('local:') ? { ...track, id: 'catalog-lookup' } : track);
    const id = kind === 'album' ? matched?.albumId : matched?.artistId;
    if (id) { navigate({ id, kind, title: kind === 'album' ? matched?.album ?? track.title : matched?.artist ?? track.artist }); return; }
    const key = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const title = kind === 'album' ? track.album ?? '' : track.artist;
    const query = kind === 'album' ? `${track.album ?? track.title} ${track.artist}` : track.artist;
    const shelves = await api.search(query, kind);
    const candidates = shelves.flatMap(shelf => shelf.items).flatMap(item => item.type === 'collection' && item.collection.kind === kind ? [item.collection] : []);
    const exact = candidates.filter(item => key(item.title) === key(title)
      && (kind === 'artist' || key(item.subtitle ?? '').includes(key(track.artist))));
    if (exact.length === 1) { navigate(exact[0]); return; }
    open({ name: 'search', query });
  } catch {
    open({ name: 'search', query: kind === 'album' ? `${track.album ?? track.title} ${track.artist}` : track.artist });
  }
}
