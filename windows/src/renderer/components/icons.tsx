// Icônes (traits simples, dans l'esprit des symboles d'Apple).
import type { SVGProps } from 'react';

const paths: Record<string, string> = {
  play: 'M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  next: 'M4 5.5v13a1 1 0 0 0 1.55.83L14 13.6v4.9a1 1 0 0 0 1.55.83l8-6.5a1 1 0 0 0 0-1.66l-8-6.5A1 1 0 0 0 14 5.5v4.9L5.55 4.67A1 1 0 0 0 4 5.5Z',
  previous: 'M20 5.5v13a1 1 0 0 1-1.55.83L10 13.6v4.9a1 1 0 0 1-1.55.83l-8-6.5a1 1 0 0 1 0-1.66l8-6.5A1 1 0 0 1 10 5.5v4.9l8.45-5.73A1 1 0 0 1 20 5.5Z',
  heart: 'M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.4 4.5 7 4.5c2.1 0 3.6 1.2 5 3 1.4-1.8 2.9-3 5-3 3.6 0 5.6 3.5 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2Z',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  search: 'M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15ZM16 16l5 5',
  home: 'M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1Z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  library: 'M4 4v16M8 4v16M12.5 4.5l6.5 15',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  lyrics: 'M4 5h16v11H9l-5 4Z M8 9h.01 M12 9h.01 M16 9h.01',
  jam: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2.5 19a5.5 5.5 0 0 1 11 0M16 11a3 3 0 1 0 0-6M18 13.6A5.5 5.5 0 0 1 21.5 19',
  shuffle: 'M3 7h3.5c2 0 3.2 1 4.4 2.8L13 13c1.2 1.8 2.4 3 4.5 3H21M18 13l3 3-3 3M3 17h3.5c1.4 0 2.4-.5 3.2-1.4M13.3 8.4C14 7.5 15 7 16.5 7H21M18 4l3 3-3 3',
  repeat: 'M4 11V9a3 3 0 0 1 3-3h13M17 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H4M7 21l-3-3 3-3',
  volume: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4ZM15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11',
  mute: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4Z',
  back: 'M15 5l-7 7 7 7',
  forward: 'M9 5l7 7-7 7',
  close: 'M6 6l12 12M18 6 6 18',
  chevronDown: 'M6 9l6 6 6-6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  music: 'M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  mic: 'M12 15a3.5 3.5 0 0 0 3.5-3.5v-5a3.5 3.5 0 0 0-7 0v5A3.5 3.5 0 0 0 12 15ZM6 11.5a6 6 0 0 0 12 0M12 17.5V21',
  album: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7.6 7.6 0 0 1-2.1 1.2l-.3 2H9.3l-.3-2a7.6 7.6 0 0 1-2.1-1.2l-1.9.7-2-3.4 1.6-1.2a7.4 7.4 0 0 1 0-3l-1.6-1.2 2-3.4 1.9.7A7.6 7.6 0 0 1 9 4.9l.3-2h4.4l.3 2a7.6 7.6 0 0 1 2.1 1.2l1.9-.7 2 3.4-1.6 1.2a7.4 7.4 0 0 1 0 3Z',
  import: 'M12 3v12M7 10l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  ticket: 'M3 8V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2a2 2 0 0 0 0 4v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6a2 2 0 0 0 0-4ZM14 5v14',
  sparkles: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8Z',
  radio: 'M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  share: 'M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  sidebar: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM9 5v14',
  sort: 'M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4',
  mini: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM12 12h6v4h-6Z',
  smart: 'M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2l.9-5.5-4-3.9 5.5-.8Z',
};

const filled = new Set(['play', 'pause', 'next', 'previous']);

export function Icon({ name, size = 20, solid: solidProp, ...props }: { name: keyof typeof paths | string; size?: number; solid?: boolean } & SVGProps<SVGSVGElement>) {
  const solid = solidProp ?? filled.has(name);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill={solid ? 'currentColor' : 'none'} stroke={solid ? 'none' : 'currentColor'}
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d={paths[name] ?? paths.music} />
    </svg>
  );
}
