(() => {
  'use strict';
  if (location.origin !== 'https://music.octavestreaming.com' || window.novaOctave) return;
  const session = navigator.mediaSession;
  const players = [];
  let anchored;
  let seek;
  window.Audio = new Proxy(window.Audio, {
    construct(Audio, args, target) {
      const audio = Reflect.construct(Audio, args, target);
      players.push(typeof WeakRef === 'function' ? new WeakRef(audio) : { deref: () => audio });
      return audio;
    },
  });
  const media = () => {
    for (let i = players.length - 1; i >= 0; i--) if (!players[i].deref()) players.splice(i, 1);
    return players.map(ref => ref.deref()).filter(audio => audio && Number.isFinite(audio.duration) && audio.duration > 0);
  };
  if (session) {
    const position = session.setPositionState;
    const setHandler = session.setActionHandler;
    if (position) session.setPositionState = function (state) {
      position.call(this, state);
      if (!state || state.position == null) return;
      anchored = media().find(audio => Math.abs(audio.duration - state.duration) < 0.25
        && Math.abs(audio.currentTime - state.position) < 0.5) ?? anchored;
    };
    session.setActionHandler = function (action, handler) {
      setHandler.call(this, action, handler);
      if (action === 'seekto') seek = handler;
    };
  }
  const visible = element => Boolean(element?.getClientRects().length);
  const row = id => /^\d{1,20}$/.test(id) ? document.querySelector('main [data-track-id="' + id + '"]') : null;
  const buttons = label => [...document.querySelectorAll('button[aria-label]')].filter(button => button.getAttribute('aria-label') === label);
  const slider = label => [...document.querySelectorAll('input[aria-label]')].find(input => input.getAttribute('aria-label') === label && visible(input));
  const blocked = () => visible(document.querySelector('[aria-label="Link Discord to unlock Octave"]')) ? 'sign-in'
    : visible(document.querySelector('[aria-label="Welcome to Octave"], #owner-note-title')) ? 'interaction' : null;

  function sample() {
    const available = media();
    const audible = available.filter(audio => !audio.paused && !audio.ended);
    const audio = audible.length === 1 ? audible[0] : available.includes(anchored) ? anchored : available.length === 1 ? available[0] : undefined;
    const position = slider('Seek');
    const metadata = session?.metadata;
    return {
      id: document.querySelector('[data-track-id][data-active="true"]')?.getAttribute('data-track-id'),
      title: metadata?.title ?? '', artist: metadata?.artist ?? '', album: metadata?.album ?? '',
      artwork: metadata?.artwork.find(item => item.src.startsWith('https:'))?.src,
      position: audio?.currentTime ?? (position ? Number(position.value) : null),
      duration: audio?.duration ?? Number(position?.max ?? 0),
      playing: session?.playbackState === 'playing' || Boolean(audio && !audio.paused && !audio.ended),
      audible: Boolean(audio && !audio.paused && !audio.muted && audio.readyState >= 2),
      ended: Boolean(audio?.ended), blocked: blocked(),
    };
  }

  function settings(options) {
    if (blocked()) return blocked();
    if (location.pathname !== '/settings') return false;
    const controls = [...document.querySelectorAll('main button')];
    const quality = controls.find(button => button.textContent.trim() === ({low: 'Low', high: 'High', lossless: 'Lossless'})[options.quality]);
    const transition = controls.find(button => button.textContent.trim() === ({off: 'Off', crossfade: 'Crossfade', automix: 'AutoMix'})[options.transition]);
    if (!quality || !transition) return false;
    quality.click();
    transition.click();
    for (const [label, key] of Object.entries({'Autoplay': 'autoplay', 'Gapless Playback': 'gapless', 'Sound Check': 'soundCheck', 'Smart Shuffle': 'smartShuffle'})) {
      const button = buttons(label)[0];
      if (button && typeof options[key] === 'boolean' && button.getAttribute('aria-checked') !== String(options[key])) button.click();
    }
    return true;
  }

  let pendingSettings;
  let updatingSettings = false;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function applyLiveSettings() {
    updatingSettings = true;
    const original = location.href;
    const link = () => document.querySelector('a[href="/settings"]');
    let opened = false;
    try {
      if (location.pathname !== '/settings') {
        if (!link()) buttons('Account')[0]?.click();
        for (let i = 0; i < 8 && !link() && location.href === original; i++) await wait(80);
        if (location.href !== original || !link()) return;
        link().click();
        opened = true;
      }
      for (let i = 0; i < 20; i++) {
        if (location.href !== original && location.pathname !== '/settings') return;
        const options = pendingSettings;
        if (settings(options) === true && options === pendingSettings) return;
        await wait(100);
      }
    } finally {
      if (opened && location.pathname === '/settings') history.back();
      updatingSettings = false;
    }
  }

  function command({type, value}) {
    if (type === 'seek' && seek && Number.isFinite(value)) {
      seek({action: 'seekto', seekTime: Math.max(0, value)});
      return true;
    }
    if (type === 'volume' || type === 'seek') {
      const input = slider(type === 'volume' ? 'Volume' : 'Seek');
      if (!input || !Number.isFinite(value)) return false;
      if (type === 'seek') input.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value));
      input.dispatchEvent(new Event('input', {bubbles: true}));
      if (type === 'seek') input.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
      return true;
    }
    const label = {next: 'Next', pause: 'Pause', play: 'Play'}[type];
    if (!label) return false;
    const button = buttons(label).find(control => !control.closest('main') && visible(control));
    if (button && !button.disabled) { button.click(); return true; }
    return false;
  }

  const calls = {
    sample, settings, command,
    settingsLive(options) {
      pendingSettings = options;
      if (!updatingSettings) void applyLiveSettings();
      return true;
    },
    select({id, retry}) {
      const track = row(id);
      const title = track?.querySelector('[data-cell="title"]') ?? track;
      if (!visible(title)) return false;
      if (retry) title.click();
      else title.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true, detail: 2}));
      return true;
    },
    queue({id}) {
      const button = row(id)?.querySelector('button[aria-label="Play next"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    },
    search({query}) {
      if (location.pathname !== '/search') {
        document.querySelector('a[href="/search"]')?.click();
        return false;
      }
      const input = document.querySelector('input[placeholder="Artists, Songs, Lyrics, and More"]');
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, query);
      input.dispatchEvent(new Event('input', {bubbles: true}));
      return true;
    },
  };
  Object.defineProperty(window, 'novaOctave', {
    value: (operation, args = {}) => Object.hasOwn(calls, operation) ? calls[operation](args) : null,
  });
})();
