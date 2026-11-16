(() => {
  'use strict';
  if (location.origin !== 'https://music.octavestreaming.com' || window.novaOctaveLibrary) return;

  // Adaptateur du client officiel : aucune lecture de clé ou de cookie, aucune
  // écriture directe du document cloud. Le client effectue les fusions.
  const modules = { library: [26029], sync: [88836], account: [67790] };
  const jobs = new Map();
  let context, sdk, connecting, jobID = 0, lastPull = 0;
  let snapshot = [], snapshotAt = 0;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const numeric = id => /^\d{1,20}$/.test(String(id)) ? String(id) : null;
  const safeImage = value => typeof value === 'string' && value.startsWith('https://') ? value : undefined;

  function inspect(chunk) {
    if (!Array.isArray(chunk)) return;
    let ids = [];
    for (const item of chunk.slice(1)) {
      if (typeof item === 'number') ids.push(item);
      else if (typeof item === 'function') {
        const source = Function.prototype.toString.call(item);
        const kind = source.includes('libraryReady') && source.includes('useLibrary') ? 'library'
          : source.includes('syncToDevice') && source.includes('syncNow') ? 'sync'
          : source.includes('useAccount') && source.includes('lastSyncedAt') ? 'account' : undefined;
        if (kind) modules[kind] = [...new Set([...ids, ...modules[kind]])];
        ids = [];
      }
    }
  }
  if (Array.isArray(window.TURBOPACK)) window.TURBOPACK.forEach(inspect);

  async function client() {
    if (sdk) return sdk;
    if (connecting) return connecting;
    connecting = (async () => {
      for (let attempt = 0; attempt < 60; attempt++) {
        const runtime = window.TURBOPACK;
        if (runtime && !Array.isArray(runtime) && typeof runtime.push === 'function') {
          if (!context) {
            const id = 1900000000 + Math.floor(Math.random() * 1000000);
            runtime.push(['nova-library-adapter.js', id, value => { context = value; }]);
            runtime.push(['nova-library-adapter-start.js', { otherChunks: [], runtimeModuleIds: [id] }]);
          }
          if (context) {
            const resolve = (kind, feature) => {
              for (const id of modules[kind]) {
                try { const value = context.i(id); if (value?.[feature]) return value; } catch {}
              }
            };
            const library = resolve('library', 'useLibrary');
            const sync = resolve('sync', 'syncToDevice');
            const account = resolve('account', 'useAccount');
            if (library && sync && account) {
              await library.libraryReady;
              sdk = { library, sync, account };
              return sdk;
            }
          }
        }
        await pause(200);
      }
      throw new Error('Le client Octave n’est pas encore prêt. Ouvre Compte Octave puis réessaie.');
    })().finally(() => { connecting = undefined; });
    return connecting;
  }

  function status(client) {
    const state = client.library.useLibrary.getState();
    const account = client.account.useAccount.getState();
    return { connected: Boolean(account.userId), pending: Boolean(account.dirty),
      albums: state.savedAlbums?.length ?? 0, artists: state.followedArtists?.length ?? 0,
      tracks: snapshot.length, updatedAt: snapshotAt };
  }

  function buildSnapshot(client) {
    const library = client.library.useLibrary.getState();
    const raw = [ ...(library.playlists ?? []).flatMap(list => list.tracks ?? []),
      ...Object.values(library.trackMeta ?? {}), ...(library.recentTracks ?? []) ];
    const seen = new Set();
    snapshot = raw.flatMap(track => {
      const id = numeric(track?.id), artist = track?.artist;
      if (!id || !track.title || seen.has(id)) return [];
      seen.add(id);
      return [{ id: 'octave:' + id, title: track.title,
        artist: typeof artist === 'string' ? artist : artist?.name ?? '',
        album: track.album?.title, duration: Number(track.duration) || undefined,
        artwork: safeImage(track.album?.cover_big ?? track.album?.cover_medium ?? track.cover_big),
        albumId: numeric(track.album?.id) ? 'octave:' + track.album.id : undefined,
        artistId: numeric(artist?.id) ? 'octave:' + artist.id : undefined, square: true }];
    });
    snapshotAt = Date.now();
    return status(client);
  }

  async function refresh() {
    const clientSDK = await client();
    const account = clientSDK.account.useAccount.getState();
    if (account.userId && Date.now() - lastPull > 30000) {
      await clientSDK.sync.syncToDevice();
      lastPull = Date.now();
    }
    return buildSnapshot(clientSDK);
  }

  async function add({ tracks = [], albums = [] }) {
    const clientSDK = await client();
    if (!clientSDK.account.useAccount.getState().userId) throw new Error('Connecte le compte cloud dans Compte Octave.');
    if (Date.now() - lastPull > 30000) await refresh();
    const releases = new Map();
    const album = async id => {
      if (!numeric(id)) throw new Error('Album Octave invalide.');
      if (!releases.has(id)) {
        const response = await fetch('https://api.octavestreaming.com/api/album/' + id);
        if (!response.ok) throw new Error('L’album Octave ne peut pas être chargé (' + response.status + ').');
        const data = await response.json();
        if (!data.album || String(data.album.id) !== String(id)) throw new Error('Réponse album Octave incomplète.');
        releases.set(id, data);
      }
      return releases.get(id);
    };
    for (const track of tracks) {
      const id = numeric(String(track.id ?? '').replace(/^octave:/, ''));
      const albumID = numeric(String(track.albumId ?? '').replace(/^octave:/, ''));
      if (!id || !albumID) throw new Error('Le morceau doit être identifié dans Octave avant l’ajout.');
      const data = await album(albumID);
      const raw = (data.tracks ?? data.album.tracks ?? []).find(item => String(item.id) === id);
      if (!raw) throw new Error('Le morceau ne figure pas dans cet album Octave.');
      const { tracks: ignored, ...release } = data.album;
      clientSDK.library.useLibrary.getState().likeTracks([{ ...raw, album: release }]);
    }
    for (const value of albums) {
      const id = numeric(String(value).replace(/^octave:/, ''));
      const data = await album(id);
      const state = clientSDK.library.useLibrary.getState();
      if (!state.isAlbumSaved(data.album.id)) state.toggleSaveAlbum(data.album);
    }
    await clientSDK.sync.syncNow();
    return buildSnapshot(clientSDK);
  }

  Object.defineProperty(window, 'novaOctaveLibrary', { value: (args = {}) => {
    if (args.operation === 'page') {
      const offset = Math.max(0, Number(args.offset) || 0);
      return { tracks: snapshot.slice(offset, offset + 300), total: snapshot.length, updatedAt: snapshotAt };
    }
    if (args.operation === 'result') {
      const result = jobs.get(args.job) ?? { error: 'Opération Octave expirée.' };
      if (!result.running) jobs.delete(args.job);
      return result;
    }
    if (!['refresh', 'add'].includes(args.operation)) return null;
    const job = ++jobID;
    jobs.set(job, { running: true });
    void (args.operation === 'add' ? add(args) : refresh()).then(
      value => jobs.set(job, { value }),
      error => jobs.set(job, { error: error?.message || 'Bibliothèque Octave indisponible.' })
    );
    for (const [key, value] of jobs) if (key < job - 20 && !value.running) jobs.delete(key);
    return { job };
  } });
})();
