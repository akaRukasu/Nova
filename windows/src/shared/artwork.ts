export function sizedArtwork(url: string | undefined, pixels: number): string | undefined {
  if (!url) return url;
  if (/^https:\/\/(?:[\w-]+\.)?(?:googleusercontent\.com|ggpht\.com)\//i.test(url)) {
    return url.replace(/=w\d+-h\d+/, `=w${pixels}-h${pixels}`).replace(/=s\d+/, `=s${pixels}`);
  }
  if (/^https:\/\/(?:[\w-]+\.)?dzcdn\.net\/images\//i.test(url)) {
    const size = pixels <= 56 ? 56 : pixels <= 250 ? 250 : pixels <= 500 ? 500 : 1000;
    return url.replace(/\/\d+x\d+(?=-)/, `/${size}x${size}`);
  }
  return url;
}
