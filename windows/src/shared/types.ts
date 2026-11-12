// Modèles partagés entre le processus principal (YouTube Music, disque) et l'interface.

export interface Track {
  id: string;
  youtubeId?: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  artwork?: string;
  artistId?: string;
  albumId?: string;
  /** Vrai pochette carrée (titre musical) ; sinon miniature vidéo 16:9. */
  square?: boolean;
}

export type CollectionKind = 'album' | 'playlist' | 'artist';

export interface Collection {
  id: string;
  kind: CollectionKind;
  title: string;
  subtitle?: string;
  artwork?: string;
  addedAt?: number;
}

export interface Category {
  title: string;
  color: string;
  browseId: string;
  params?: string;
}

export type Item =
  | { type: 'track'; track: Track }
  | { type: 'collection'; collection: Collection }
  | { type: 'category'; category: Category };

export type ShelfLayout = 'list' | 'cards' | 'grid';

export interface BrowseLink {
  browseId: string;
  params?: string;
}

export interface Shelf {
  id: string;
  title: string;
  items: Item[];
  layout: ShelfLayout;
  more?: BrowseLink;
}

export interface PageHeader {
  title: string;
  subtitle?: string;
  description?: string;
  artwork?: string;
}

export interface Page {
  header?: PageHeader;
  shelves: Shelf[];
  continuation?: boolean;
}

export interface CollectionPage {
  header: PageHeader;
  tracks: Track[];
  related: Shelf[];
}

export interface LyricLine {
  time: number;
  text: string;
}

export interface Lyrics {
  text: string;
  source?: string;
  lines?: LyricLine[];
}

export interface UserPlaylist {
  id: string;
  name: string;
  tracks: Track[];
  created: number;
  lastPlayedAt?: number;
  /** Playlist du compte YouTube correspondante (synchronisée avec l'iPhone). */
  youtubeId?: string;
}

export interface SharedPlaylist {
  /** Identifiant YouTube, sans « VL ». */
  id: string;
  title: string;
  artwork?: string;
  isOwner: boolean;
}

export interface TrackStats {
  playCount: number;
  lastPlayed?: number;
  addedAt?: number;
}

export type ListeningYear = Record<string, { track: Track; plays: number }>;

export type Transition = 'off' | 'crossfade' | 'automix';

export interface OctaveAudioSettings {
  automixStyle?: 'automatic' | 'apple' | 'legacy';
  quality: 'low' | 'high' | 'lossless';
  transition: Transition;
  autoplay: boolean;
  gapless: boolean;
  soundCheck: boolean;
  smartShuffle: boolean;
}

export interface Settings {
  region: string;
  language: string;
  highQuality: boolean;
  transition: Transition;
  crossfadeSeconds: number;
  autoplayRadio: boolean;
  recordHistory: boolean;
  syncOctaveToYouTube?: boolean;
  playlistSource?: 'octave' | 'youtube';
  octaveAudio?: OctaveAudioSettings;
  ticketmasterKey: string;
  jamName: string;
  theme: 'system' | 'dark' | 'light';
  /** Lecture : automatique (direct, puis lecteur officiel si YouTube refuse), direct, ou lecteur officiel. */
  engine: 'auto' | 'direct' | 'web';
  /** Égaliseur de volume : les titres très forts sont baissés au niveau des autres. */
  normalizeVolume?: boolean;
  /** Préréglage de l'égaliseur (voir equalizer.ts). */
  equalizer?: string;
}

export const defaultSettings: Settings = {
  region: 'FR',
  language: 'fr',
  highQuality: true,
  transition: 'automix',
  crossfadeSeconds: 6,
  autoplayRadio: true,
  recordHistory: true,
  syncOctaveToYouTube: true,
  playlistSource: 'octave',
  ticketmasterKey: '',
  jamName: '',
  theme: 'system',
  engine: 'auto',
};

export type SmartField = 'title' | 'artist' | 'album' | 'playCount' | 'lastPlayed' | 'liked';
export type SmartOperator = 'contains' | 'is' | 'not' | 'greater' | 'less' | 'inLast' | 'notInLast';

export interface SmartRule {
  field: SmartField;
  operator: SmartOperator;
  value: string;
}

export interface SmartPlaylist {
  id: string;
  name: string;
  rules: SmartRule[];
  matchAll: boolean;
  limit?: number;
  sort: 'recent' | 'mostPlayed' | 'title' | 'random';
}

export interface LibraryState {
  recents: Track[];
  liked: Track[];
  playlists: UserPlaylist[];
  smartPlaylists?: SmartPlaylist[];
  /** Playlists collaboratives (YouTube Music) créées ou rejointes. */
  shared?: SharedPlaylist[];
  /** Titres ajoutés à la bibliothèque sans playlist (bouton « + » de l'iPhone). */
  added?: Track[];
  saved: Collection[];
  searches: string[];
  stats: Record<string, TrackStats>;
  listeningYears?: Record<string, ListeningYear>;
  historyChanges?: import('./historySync.js').HistoryChanges;
  settings: Settings;
}

export interface Account {
  signedIn: boolean;
  name?: string;
  photo?: string;
}

export interface ImportedTrack {
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  /** Déjà sur YouTube Music (import d'une playlist YouTube) : pas de recherche. */
  youtubeId?: string;
}

export interface ImportedPlaylist {
  name: string;
  source: string;
  tracks: ImportedTrack[];
  existingYoutubeId?: string;
}

export interface ImportProgress {
  name: string;
  total: number;
  processed: number;
  matched: number;
  missing: ImportedTrack[];
  done: boolean;
  /** Seconde recherche des titres pas encore trouvés. */
  verifying?: boolean;
  playlistId?: string;
}

export interface Concert {
  id: string;
  name: string;
  date: string;
  place: string;
  city: string;
  url?: string;
  image?: string;
}

export interface JamState {
  hostName: string;
  queue: Track[];
  index: number;
  playing: boolean;
  position: number;
  sentAt: number;
  participants: string[];
  addedBy: Record<string, string>;
}

export interface NearbyJam {
  id: string;
  name: string;
  address: string;
  port: number;
}
