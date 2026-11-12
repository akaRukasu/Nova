// Couleurs d'une pochette (ambiance de l'interface) : moyenne sombre pour le fond, teinte vive pour l'accent.
import { nativeImage, net } from 'electron';

export interface Palette { background: [number, number, number]; vivid: [number, number, number] }

const cache = new Map<string, Palette | null>();

export async function palette(url: string): Promise<Palette | null> {
  if (!/^https:\/\/[^/]*(googleusercontent\.com|ggpht\.com|ytimg\.com)\//.test(url)) return null;
  if (cache.has(url)) return cache.get(url)!;
  try {
    const response = await net.fetch(url.replace(/=w\d+-h\d+[^&]*$/, '=w64-h64'));
    if (!response.ok) throw new Error(String(response.status));
    const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer())).resize({ width: 24, height: 24 });
    const pixels = image.toBitmap();
    let r = 0, g = 0, b = 0, count = 0;
    let vivid: [number, number, number] = [250, 46, 84], best = -1;
    for (let i = 0; i + 3 < pixels.length; i += 4) {
      // Pixels BGRA.
      const pb = pixels[i], pg = pixels[i + 1], pr = pixels[i + 2];
      r += pr; g += pg; b += pb; count++;
      const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
      const saturation = max ? (max - min) / max : 0;
      const light = max / 255;
      // Teinte vive, ni trop sombre ni délavée.
      const score = saturation * (light > 0.25 ? 1 : light * 4) * (light > 0.92 ? 0.6 : 1);
      if (score > best) { best = score; vivid = [pr, pg, pb]; }
    }
    if (!count) throw new Error('vide');
    const result: Palette = { background: [Math.round(r / count), Math.round(g / count), Math.round(b / count)], vivid: best > 0.15 ? vivid : [250, 46, 84] };
    cache.set(url, result);
    if (cache.size > 300) cache.delete(cache.keys().next().value as string);
    return result;
  } catch {
    cache.set(url, null);
    return null;
  }
}
