import type { LibraryState, Track } from './types.js';

const image = (url?: string) => url && /^https?:\/\//.test(url) ? url : undefined;
const track = (t: Track) => ({ id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration,
  artworkURL: image(t.artwork), artistID: t.artistId, albumID: t.albumId, youtubeID: t.youtubeId, localFileName: t.localFileName });

/** Même format portable que l’export iPhone. Aucun chemin privé ni identifiant de connexion. */
export function portableBackup(state: LibraryState, exportedAt = Date.now(), uuid: (value: string) => string = value => value) {
  return { format: 'nova-library', version: 1, exportedAt,
    library: {
      recents: state.recents.map(track), liked: state.liked.map(track), addedTracks: (state.added ?? []).map(track),
      playlists: state.playlists.map(p => ({ id: uuid(p.id), name: p.name, tracks: p.tracks.map(track),
        createdAt: Number.isFinite(p.created) ? p.created : exportedAt, lastPlayedAt: p.lastPlayedAt })),
      saved: state.saved.map(c => ({ id: c.id, kind: c.kind, title: c.title, subtitle: c.subtitle ?? '', artworkURL: image(c.artwork) })),
      savedDates: Object.fromEntries(state.saved.filter(c => c.addedAt != null).map(c => [c.id, c.addedAt])),
      searches: state.searches,
      smartPlaylists: (state.smartPlaylists ?? []).map(p => ({ id: uuid(p.id), name: p.name, matchAll: p.matchAll,
        limit: p.limit, sort: p.sort === 'recent' ? 'recentlyPlayed' : p.sort,
        rules: p.rules.map((r, i) => ({ id: uuid(p.id + ':rule:' + i), field: r.field,
          op: r.field === 'liked' ? ((/^(?:true|1|yes|oui)$/i.test(r.value) !== (r.operator === 'not')) ? 'isTrue' : 'isFalse')
            : r.operator === 'not' ? 'notContains' : r.operator,
          text: r.value, number: Number(r.value) || 0 })) })),
      stats: Object.fromEntries(Object.entries(state.stats).map(([id, s]) => [id, {
        playCount: Number.isFinite(s.playCount) ? Math.max(0, Math.floor(s.playCount)) : 0, lastPlayed: s.lastPlayed, added: s.addedAt,
      }])),
      listeningYears: Object.fromEntries(Object.entries(state.listeningYears ?? {}).map(([year, entries]) =>
        [year, Object.fromEntries(Object.entries(entries).map(([id, e]) => [id, { track: track(e.track), plays: e.plays }]))])),
      historyClearedAt: state.historyChanges?.clearedAt, historyRemoved: state.historyChanges?.removed,
      libraryRemoved: state.libraryChanges?.removed, libraryRestored: state.libraryChanges?.restored,
    },
    shared: (state.shared ?? []).map(c => ({id: c.id, title: c.title, artworkURL: image(c.artwork), isOwner: !!c.isOwner})),
  };
}
