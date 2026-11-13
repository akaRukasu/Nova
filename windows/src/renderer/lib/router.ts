// Navigation : une pile de pages, avec retour et avance (comme un navigateur).
import type { BrowseLink, Collection } from '../../shared/types';
import { Store } from './store';

export type Route =
  | { name: 'home' }
  | { name: 'explore' }
  | { name: 'search'; query?: string }
  | { name: 'browse'; title: string; link: BrowseLink }
  | { name: 'artist'; id: string; title: string }
  | { name: 'collection'; collection: Collection }
  | { name: 'playlist'; id: string }
  | { name: 'smart'; id: string }
  | { name: 'songs' }
  | { name: 'liked' }
  | { name: 'history' }
  | { name: 'wrapped' }
  | { name: 'albums' }
  | { name: 'artists' }
  | { name: 'libraryGroup'; kind: 'album' | 'artist'; id: string }
  | { name: 'recent' }
  | { name: 'youtubePlaylists' }
  | { name: 'mix'; kind: string }
  | { name: 'import' }
  | { name: 'concerts'; artist?: string }
  | { name: 'jam' }
  | { name: 'settings' };

export const router = new Store<{ stack: Route[]; position: number }>({ stack: [{ name: 'home' }], position: 0 });

export const currentRoute = () => router.get().stack[router.get().position];

export function open(route: Route) {
  router.set(({ stack, position }) => ({ stack: [...stack.slice(0, position + 1), route], position: position + 1 }));
  document.querySelector('main')?.scrollTo({ top: 0 });
}

/** Rubrique de la barre latérale : repart d'une pile neuve. */
export function root(route: Route) {
  router.set(({ stack, position }) => ({ stack: [...stack.slice(0, position + 1), route], position: position + 1 }));
  document.querySelector('main')?.scrollTo({ top: 0 });
}

export function back() {
  router.set((state) => ({ ...state, position: Math.max(0, state.position - 1) }));
}

export function forward() {
  router.set((state) => ({ ...state, position: Math.min(state.stack.length - 1, state.position + 1) }));
}

export function routeForLink(link: BrowseLink, title: string): Route {
  const id = link.browseId;
  if (!link.params && id.startsWith('UC')) return { name: 'artist', id, title };
  if (!link.params && id.startsWith('MPREb')) return { name: 'collection', collection: { id, kind: 'album', title } };
  if (id.startsWith('VL')) return { name: 'collection', collection: { id, kind: 'playlist', title } };
  return { name: 'browse', title, link };
}
