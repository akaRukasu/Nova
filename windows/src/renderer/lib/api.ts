// Appels au processus principal (YouTube Music, disque, compte, import, Jam).
import type {
  Account, BrowseLink, Collection, CollectionPage, Concert, ImportedPlaylist, ImportedTrack, LibraryState, Lyrics,
  NearbyJam, Page, PageHeader, Settings, Shelf, Track,
} from '../../shared/types';

declare global {
  interface Window {
    nova: {
      invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>;
      on: (channel: string, listener: (...args: any[]) => void) => () => void;
    };
  }
}

const call = <T,>(channel: string, ...args: unknown[]) => window.nova.invoke<T>(channel, ...args);
export const on = (channel: string, listener: (...args: any[]) => void) => window.nova.on(channel, listener);

export type SearchScope = 'all' | 'song' | 'video' | 'album' | 'artist' | 'playlist';

export const api = {
  search: (query: string, scope: SearchScope) => call<Shelf[]>('yt:search', query, scope),
  suggestions: (query: string) => call<string[]>('yt:suggestions', query),
  home: () => call<Page>('yt:home'),
  homeMore: () => call<Page>('yt:homeMore'),
  explore: () => call<Page>('yt:explore'),
  browse: (link: BrowseLink) => call<Page>('yt:browse', link),
  artist: (id: string) => call<{ header: PageHeader; shelves: Shelf[]; tracks: Track[] }>('yt:artist', id),
  artistSongs: (id: string) => call<Track[]>('yt:artistSongs', id),
  collection: (target: Collection) => call<CollectionPage>('yt:collection', target),
  radio: (id: string) => call<Track[]>('yt:radio', id),
  related: (id: string) => call<Shelf[]>('yt:related', id),
  squareArtwork: (id: string) => call<string | undefined>('yt:squareArtwork', id),
  lyrics: (track: Track, duration?: number) => call<Lyrics | undefined>('lyrics:get', track, duration),
  prefetch: (id: string) => call<void>('stream:prefetch', id),
  invalidate: (id: string) => call<void>('stream:invalidate', id),
  streamError: (id: string) => call<string | undefined>('stream:error', id),

  loadLibrary: () => call<LibraryState>('library:load'),
  saveLibrary: (state: LibraryState) => call<void>('library:save', state),
  applySettings: (settings: Settings) => call<void>('settings:apply', settings),

  account: () => call<Account>('account:get'),
  login: () => call<boolean>('account:login'),
  logout: () => call<void>('account:logout'),
  accountLiked: () => call<Track[]>('account:liked'),
  accountPlaylists: () => call<Collection[]>('account:playlists'),
  setLike: (id: string, liked: boolean) => call<void>('account:like', id, liked),
  createAccountPlaylist: (name: string, ids: string[], privacy?: string) => call<string | undefined>('account:createPlaylist', name, ids, privacy),
  openYouTube: (url: string) => call<void>('youtube:open', url),
  addToAccountPlaylist: (playlistId: string, ids: string[]) => call<void>('account:addToPlaylist', playlistId, ids),

  importLink: (link: string) => call<ImportedPlaylist[]>('import:link', link),
  importFile: () => call<ImportedPlaylist[]>('import:file'),
  runImport: (playlists: ImportedPlaylist[], toAccount: boolean) =>
    call<{ name: string; tracks: Track[]; youtubeId?: string; missing: number }[]>('import:run', playlists, toAccount),
  matchTrack: (wanted: ImportedTrack) => call<Track | undefined>('import:match', wanted),
  cancelImport: () => call<void>('import:cancel'),

  phonePairing: () => call<{ link: string; address: string; paired: boolean; phoneName?: string; lastSync?: number }>('phone:pairing'),
  unpairPhone: () => call<void>('phone:unpair'),
  openPhoneExport: () => call<unknown>('phone:openFile'),

  concerts: (options: { artist?: string; city?: string; key: string }) => call<Concert[]>('concerts:search', options),

  jamHost: (name: string) => call<{ port: number; addresses: string[] }>('jam:host', name),
  jamBroadcast: (message: unknown) => call<void>('jam:broadcast', message),
  jamBrowse: () => call<void>('jam:browse'),
  jamStopBrowsing: () => call<void>('jam:stopBrowsing'),
  jamJoin: (address: string, port: number, name: string) => call<void>('jam:join', address, port, name),
  jamToHost: (message: unknown) => call<void>('jam:toHost', message),
  jamStop: () => call<void>('jam:stop'),

  openExternal: (url: string) => call<void>('shell:open', url),
};

export type { NearbyJam };
