import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parseFile } from 'music-metadata';
import type { Track } from '../shared/types.js';

export class LocalAudioLibrary {
  constructor(private readonly directory: () => string) {}

  async import(files: string[]) {
    const tracks: Track[] = [], errors: string[] = [];
    await mkdir(this.directory(), { recursive: true });
    for (const file of files) {
      try {
        const metadata = await parseFile(file, { duration: true });
        if (!metadata.format.codec) throw new Error('Format audio non reconnu.');
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(file)) digest.update(chunk);
        const hash = digest.digest('hex');
        const extension = path.extname(file).toLowerCase().slice(1);
        if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new Error('Extension audio non reconnue.');
        const filename = hash + '.' + extension;
        const destination = path.join(this.directory(), filename);
        const temp = destination + '.' + crypto.randomUUID() + '.tmp';
        await copyFile(file, temp);
        await rename(temp, destination);
        const picture = metadata.common.picture?.find(image => image.data.length <= 10_000_000);
        if (picture) await writeFile(path.join(this.directory(), hash + '.cover'), picture.data);
        const parts = path.basename(file, path.extname(file)).split(' - ');
        const track: Track = {
          id: 'local:' + hash, localFileName: filename,
          title: metadata.common.title ?? (parts.length > 1 ? parts.slice(1).join(' - ') : parts[0]),
          artist: metadata.common.artist ?? (parts.length > 1 ? parts[0] : 'Artiste inconnu'),
          album: metadata.common.album, duration: metadata.format.duration, square: true,
          artwork: picture ? 'nova-stream://cover/' + hash : undefined,
        };
        await writeFile(path.join(this.directory(), hash + '.json'), JSON.stringify(track));
        if (!tracks.some(item => item.id === track.id)) tracks.push(track);
      } catch (error) {
        errors.push(path.basename(file) + ' — ' + (error instanceof Error ? error.message : String(error)));
      }
    }
    return { tracks, errors };
  }

  async response(id: string, range: string | null, cover = false) {
    const hash = id.replace(/^local:/, '');
    if (!/^[a-f0-9]{64}$/.test(hash)) return new Response('Identifiant local invalide', { status: 400 });
    try {
      const entry = JSON.parse(await readFile(path.join(this.directory(), hash + '.json'), 'utf8')) as Track;
      const filename = entry.localFileName ?? '';
      if (!filename.startsWith(hash + '.') || path.basename(filename) !== filename) throw new Error('Fichier local invalide');
      const file = path.join(this.directory(), cover ? hash + '.cover' : filename);
      const size = (await stat(file)).size;
      const headers = new Headers({ 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' });
      const extension = path.extname(filename).toLowerCase();
      const mime: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
        '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aiff': 'audio/aiff', '.aif': 'audio/aiff' };
      headers.set('content-type', cover ? 'image/jpeg' : mime[extension] ?? 'application/octet-stream');
      let start = 0, end = size - 1;
      if (range) {
        const match = range.match(/^bytes=(\d*)-(\d*)$/);
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + size } });
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + size } });
        headers.set('content-range', 'bytes ' + start + '-' + end + '/' + size);
      }
      headers.set('content-length', String(end - start + 1));
      const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch {
      return new Response('Le fichier audio local est absent de cet appareil.', { status: 404 });
    }
  }
}

