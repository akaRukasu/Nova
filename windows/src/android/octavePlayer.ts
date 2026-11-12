import { findRecording } from '../main/octave';
import { sameRecordingCredits } from '../main/matcher';
import { octaveAudioDefaults, octaveCatalogId, octaveId, octaveOrigin, octaveTrackUrl } from '../shared/octave';
import type { OctaveCommand, OctavePlayback, OctaveStart } from '../shared/octave';
import type { OctaveAudioSettings, Track } from '../shared/types';

type Sample = {
  id?: string; title: string; artist: string; album?: string; artwork?: string;
  position: number | null; duration: number; playing: boolean; audible: boolean; ended: boolean;
  blocked?: 'sign-in' | 'interaction';
  upcoming?: Track[];
  mixing?: boolean;
};
type Playback = {
  request: number; track: Track; source: Track; position: number; heard: number; recorded: boolean; playing: boolean;
  next?: { track: Track; source: Track }; endedAt?: number;
};
const settingsURL = octaveOrigin + '/settings';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const matches = (track: Track, sample: Sample) => sample.id && octaveCatalogId(track.id)
  ? octaveCatalogId(track.id) === sample.id && sameRecordingCredits(track, {id:'sample',title:sample.title,artist:sample.artist})
  : sameRecordingCredits(track, {id:'sample',title:sample.title,artist:sample.artist});

export class AndroidOctavePlayer {
  settings = octaveAudioDefaults;
  private operation = 0;
  private active?: Playback;
  private audio?: string;
  private warming?: Promise<'sign-in' | 'interaction' | undefined>;
  private observing = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly native: {
      octaveNavigate(options: { url: string }): Promise<void>;
      octaveCall(options: { operation: string; args?: object }): Promise<{ value: string }>;
      octavePanel(options: { visible: boolean }): Promise<void>;
    },
    private readonly publish: (state: OctavePlayback) => void,
    private readonly record: (track: Track) => void,
  ) {}

  private async call<T>(operation: string, args?: object): Promise<T | null> {
    try {
      const { value } = await this.native.octaveCall({ operation, args });
      return JSON.parse(value) as T | null;
    } catch {
      return null;
    }
  }

  setSettings(value?: OctaveAudioSettings) {
    const next = { ...octaveAudioDefaults, ...value };
    const changed = JSON.stringify(next) !== JSON.stringify(this.settings);
    this.settings = next;
    if (changed && this.active) {
      this.audio = undefined;
      void this.call('settingsLive', next);
    }
  }

  warmUp() { void this.prepare().catch(() => undefined); }

  private prepare() {
    const settings = this.settings;
    const key = JSON.stringify(settings);
    if (key === this.audio) return Promise.resolve(undefined);
    if (this.warming) return this.warming;
    this.warming = (async () => {
      await this.native.octaveNavigate({ url: settingsURL });
      for (let i = 0; i < 20; i++) {
        const result = await this.call<boolean | 'sign-in' | 'interaction'>('settings', settings);
        if (result === 'sign-in' || result === 'interaction') return result;
        if (result === true) { this.audio = key; return undefined; }
        await wait(200);
      }
    })().finally(() => { this.warming = undefined; });
    return this.warming;
  }

  async open(address = settingsURL) {
    await this.stop();
    await this.native.octavePanel({ visible: true });
    await this.native.octaveNavigate({ url: address });
  }

  hide() { return this.native.octavePanel({ visible: false }); }

  stop() {
    this.operation++;
    this.active = undefined;
    clearInterval(this.timer);
    return this.call<boolean>('command', { type: 'pause' });
  }

  async play(track: Track, request: number, volume: number, position: number): Promise<OctaveStart> {
    const paused = this.stop();
    const operation = this.operation;
    await this.hide();
    const selected = await findRecording(track);
    const id = selected && octaveCatalogId(selected.id);
    if (operation !== this.operation) return 'cancelled';
    if (!id || !selected) return 'not-found';
    await paused;
    const blocked = await this.prepare();
    if (operation !== this.operation) return 'cancelled';
    if (blocked) {
      await this.native.octavePanel({ visible: true });
      return blocked;
    }
    const search = new URL('/search', octaveOrigin);
    search.searchParams.set('q', `${selected.title} ${selected.artist}`);
    for (const url of [octaveTrackUrl(selected), search.href]) {
      if (operation !== this.operation) return 'cancelled';
      await this.native.octaveNavigate({ url });
      let selectedAt = 0;
      let retried = false;
      const deadline = Date.now() + 8500;
      while (operation === this.operation && Date.now() < deadline) {
        const sample = await this.call<Sample>('sample');
        if (operation !== this.operation) return 'cancelled';
        if (sample?.blocked) {
          await this.native.octavePanel({ visible: true });
          return sample.blocked;
        }
        if (sample?.playing && sample.position != null && matches(selected, sample)) {
          await this.call('command', { type: 'volume', value: volume });
          if (operation !== this.operation) return 'cancelled';
          if (position > 0 || sample.position > 2) await this.call('command', { type: 'seek', value: position });
          if (operation !== this.operation) return 'cancelled';
          this.active = { request, track, source: selected, position, heard: 0, recorded: false, playing: true };
          this.timer = setInterval(() => void this.observe(), 300);
          return 'playing';
        }
        if (!selectedAt || (!retried && Date.now() - selectedAt > 1800 && (!sample || !matches(selected, sample)))) {
          if (await this.call<boolean>('select', { id, retry: Boolean(selectedAt) })) {
            retried = Boolean(selectedAt);
            selectedAt = Date.now();
          }
        }
        await wait(180);
      }
    }
    if (operation !== this.operation) return 'cancelled';
    await this.stop();
    return 'unavailable';
  }

  async command(request: number, command: OctaveCommand) {
    if (this.active?.request !== request) return false;
    if (command.type === 'seek' || command.type === 'pause') this.active.endedAt = undefined;
    return Boolean(await this.call('command', command));
  }

  async queueNext(request: number, track: Track) {
    const active = this.active;
    if (!active || active.request !== request) return;
    const source = await findRecording(track);
    const id = source && octaveCatalogId(source.id);
    if (!id || !source || source.id === active.source.id || this.active !== active) return;
    let searched = false;
    for (let i = 0; this.active === active && i < 20; i++) {
      if (await this.call<boolean>('queue', { id })) {
        if (this.active !== active) return;
        active.next = { track, source };
        return source.id;
      }
      if (!searched) searched = Boolean(await this.call('search', { query: `${source.title} ${source.artist}` }));
      await wait(280);
    }
  }

  private async observe() {
    const active = this.active;
    if (!active || this.observing) return;
    this.observing = true;
    try {
      const sample = await this.call<Sample>('sample');
      if (!sample || this.active !== active) return;
      if (sample.blocked === 'sign-in') {
        await this.stop();
        await this.native.octavePanel({ visible: true });
        this.publish({ request: active.request, time: active.position, duration: sample.duration, playing: false, signIn: true });
        return;
      }
      if (sample.position == null || !sample.title) return;
      if (sample.mixing) {
        if (matches(active.source, sample)) active.position = sample.position;
        this.publish({request:active.request,time:active.position,duration:active.source.duration ?? sample.duration,
          playing:sample.playing,mixing:true,upcoming:sample.upcoming});
        return;
      }
      let next: Track | undefined;
      if (sample.playing && !matches(active.source, sample)) {
        const planned = active.next;
        next = planned && matches(planned.source, sample) ? planned.source : {
          id: octaveId(sample.id) ?? `octave:played-${encodeURIComponent([sample.title, sample.artist, sample.album].join('|'))}`,
          title: sample.title, artist: sample.artist, album: sample.album, artwork: sample.artwork, duration: sample.duration, square: true,
        };
        active.track = next === planned?.source ? planned.track : next;
        active.source = next;
        active.next = undefined;
        active.heard = 0;
        active.recorded = false;
      }
      if (sample.playing) active.endedAt = undefined;
      else if (sample.ended || (active.playing && sample.duration > 0 && sample.duration - active.position < 1.5)) active.endedAt ??= Date.now();
      const ended = Boolean(active.endedAt && Date.now() - active.endedAt > 2500);
      const elapsed = sample.position - active.position;
      active.position = sample.position;
      active.playing = sample.playing;
      if (ended) await this.stop();
      this.publish({ request: active.request, time: sample.position, duration: sample.duration, playing: sample.playing, track: next, ended,
        upcoming: sample.upcoming, mixing: sample.mixing });
      if (!next && !active.recorded && sample.audible && elapsed > 0 && elapsed < 2) {
        active.heard += elapsed;
        if (active.heard >= 5) { active.recorded = true; this.record(active.track); }
      }
    } finally {
      this.observing = false;
    }
  }
}
