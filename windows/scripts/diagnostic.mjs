// Diagnostic de Nova pour Windows : interroge vraiment YouTube Music (et LRCLIB, Deezer) avec le code de l'app.
import '../dist/main/evalNode.js';
import * as yt from '../dist/main/yt.js';
import { lyrics } from '../dist/main/lyrics.js';
import { match } from '../dist/main/matcher.js';
import { fromLink } from '../dist/main/importer.js';
import { networkStatus } from '../dist/main/firewall.js';

let failures = 0;
async function step(title, body) {
  const started = Date.now();
  process.stdout.write(`\n=== ${title}\n`);
  try {
    await body();
    console.log(`  (${Date.now() - started} ms)`);
  } catch (error) {
    failures++;
    console.log(`  ERREUR : ${error?.stack ?? error}`);
  }
}

const show = (shelves, items = 2) => {
  console.log(`  ${shelves.length} étagère(s)`);
  for (const shelf of shelves.slice(0, 8)) {
    console.log(`  [${shelf.layout}] « ${shelf.title} » : ${shelf.items.length} élément(s)${shelf.more ? ` plus=${shelf.more.browseId}` : ''}`);
    for (const item of shelf.items.slice(0, items)) {
      if (item.type === 'track') console.log(`      ♪ ${item.track.artist} — ${item.track.title} (${item.track.id}) durée=${item.track.duration ?? '-'} carré=${item.track.square}`);
      if (item.type === 'collection') console.log(`      ▣ [${item.collection.kind}] ${item.collection.title} id=${item.collection.id}`);
      if (item.type === 'category') console.log(`      ▦ ${item.category.title} ${item.category.browseId}`);
    }
  }
};

yt.configure({ lang: 'fr', location: 'FR' });
let song, artistId, albumId, playlistId, category;

await step('Recherche « Tout »', async () => {
  const shelves = await yt.search('daft punk', 'all');
  show(shelves);
});
await step('Recherche « Titres »', async () => {
  const shelves = await yt.search('daft punk get lucky', 'song');
  show(shelves, 3);
  song = shelves.flatMap((s) => s.items).find((i) => i.type === 'track')?.track;
  artistId = song?.artistId;
  albumId = song?.albumId;
});
await step('Recherche « Playlists »', async () => {
  const shelves = await yt.search('french touch', 'playlist');
  show(shelves, 2);
  playlistId = shelves.flatMap((s) => s.items).find((i) => i.type === 'collection')?.collection.id;
});
await step('Suggestions', async () => console.log('  ' + (await yt.suggestions('daft p')).join(' | ')));
await step('Accueil', async () => {
  const page = await yt.home();
  show(page.shelves, 1);
  if (page.continuation) show((await yt.homeMore()).shelves, 1);
});
await step('Nouveautés', async () => show((await yt.explore()).shelves, 2));
await step('Humeurs et genres', async () => {
  const page = await yt.browse({ browseId: 'FEmusic_moods_and_genres' });
  show(page.shelves, 2);
  category = page.shelves.flatMap((s) => s.items).find((i) => i.type === 'category')?.category;
});
if (category) await step(`Catégorie ${category.title}`, async () => show((await yt.browse({ browseId: category.browseId, params: category.params })).shelves, 1));
if (artistId) await step(`Artiste ${artistId}`, async () => {
  const page = await yt.artist(artistId);
  console.log(`  ${page.header.title} · image=${!!page.header.artwork} · ${page.tracks.length} titres phares`);
  show(page.shelves, 1);
  console.log(`  Tous les titres : ${(await yt.artistAllSongs(artistId)).length}`);
});
if (albumId) await step(`Album ${albumId}`, async () => {
  const page = await yt.collection({ id: albumId, kind: 'album', title: '' });
  console.log(`  ${page.header.title} · ${page.header.subtitle} · ${page.tracks.length} titres`);
  page.tracks.slice(0, 3).forEach((t) => console.log(`      ♪ ${t.artist} — ${t.title} durée=${t.duration}`));
});
if (playlistId) await step(`Playlist ${playlistId}`, async () => {
  const page = await yt.collection({ id: playlistId, kind: 'playlist', title: '' });
  console.log(`  ${page.header.title} · ${page.tracks.length} titres`);
});
if (song) {
  await step(`Radio de ${song.title}`, async () => {
    const tracks = await yt.radio(song.id);
    console.log(`  ${tracks.length} titres ; 1er : ${tracks[0]?.title} durée=${tracks[0]?.duration}`);
  });
  await step('Paroles synchronisées', async () => {
    const found = await lyrics(song, song.duration);
    console.log(`  ${found?.lines?.length ?? 0} lignes synchronisées, source=${found?.source}`);
  });
  await step('Flux audio (déchiffrement + premiers octets)', async () => {
    const stream = await yt.stream(song.id, true);
    console.log(`  ${stream.mime}${stream.bitrate ? ` · ${Math.round(stream.bitrate / 1000)} kbit/s` : ''} · expire ${new Date(stream.expires).toISOString()} · durée ${stream.duration}`);
    const response = await fetch(stream.url, { headers: { range: 'bytes=0-65535' } });
    const bytes = (await response.arrayBuffer()).byteLength;
    console.log(`  HTTP ${response.status} · ${bytes} octets`);
    if (![200, 206].includes(response.status) || bytes < 1000) throw new Error('Flux audio illisible');
  });
}
await step('Pochette HD d’un clip', async () => {
  const shelves = await yt.search('BAILE INoLVIDABLE Bad Bunny', 'video');
  const video = shelves.flatMap((s) => s.items).find((i) => i.type === 'track')?.track;
  console.log(`  ${video?.title} → ${await yt.squareArtwork(video.id)}`);
});
await step('Import Deezer', async () => {
  const [playlist] = await fromLink('https://www.deezer.com/fr/album/302127');
  console.log(`  « ${playlist.name} » : ${playlist.tracks.length} titres`);
});
await step('Correspondance difficile', async () => {
  for (const wanted of [
    { title: 'Alors on dance', artist: 'Stromae', duration: 207 },
    { title: 'Bohemian Rhapsody - Remastered 2011', artist: 'Queen', album: 'A Night At The Opera' },
    { title: 'Tout va bien', artist: 'Orelsan, Ibeyi' },
  ]) {
    const found = await match(wanted);
    console.log(`  ${found ? '✓' : '✗'} ${wanted.artist} — ${wanted.title}${found ? `  →  ${found.artist} — ${found.title}` : ''}`);
  }
});

if (process.platform === 'win32') await step('Pare-feu de Windows (réseaux publics, règle de Nova)', async () => {
  const status = await networkStatus();
  console.log(`  réseaux publics : ${status.publicNetworks.join(', ') || 'aucun'} · règle de Nova : ${status.allowed ? 'oui' : 'non'}`);
});

console.log(`\nTerminé : ${failures} étape(s) en échec.`);
process.exit(failures > 3 ? 1 : 0);
