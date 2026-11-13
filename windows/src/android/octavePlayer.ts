import { findRecording } from '../main/octave';
import { sameRecordingCredits } from '../main/matcher';
import { octaveAudioDefaults, octaveCatalogId, octaveHandoff, octaveId, octaveOrigin, octaveQueueQueries, octaveTrackUrl } from '../shared/octave';
import type { OctaveCommand, OctavePlayback, OctaveStart } from '../shared/octave';
import type { OctaveAudioSettings, Track } from '../shared/types';

type Sample = {
  id?: string; title: string; artist: string; album?: string; artwork?: string;
  position: number | null; duration: number; playing: boolean; audible: boolean; ended: boolean;
  outgoingPosition?: number;
  blocked?: 'sign-in' | 'interaction';
  upcoming?: Track[];
  mixing?: boolean;
  fading?: boolean;
  audioId?: number;
  buffering?: boolean;
};
type Playback = {
  request: number; track: Track; source: Track; position: number; duration: number; heard: number; recorded: boolean; playing: boolean;
  next?: { track: Track; source: Track }; endedAt?: number;
  queueVersion?: number;
  audioId?: number;
  handoffAt?: number;
  seekUntil?: number;
};
const settingsURL = octaveOrigin + '/settings';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const matches = (track: Track, sample: Sample) => sample.title
  ? sameRecordingCredits(track, {id:'sample',title:sample.title,artist:sample.artist})
  : !!sample.id && octaveCatalogId(track.id) === sample.id;

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
      let resumed = false;
      const deadline = Date.now() + 8500;
      while (operation === this.operation && Date.now() < deadline) {
        const sample = await this.call<Sample>('sample');
        if (operation !== this.operation) return 'cancelled';
        if (sample?.blocked) {
          await this.native.octavePanel({ visible: true });
          return sample.blocked;
        }
        const sameTrack = sample && matches(selected, sample);
        if (sameTrack && sample.playing && sample.position != null) {
          await this.call('command', { type: 'volume', value: volume });
          if (operation !== this.operation) return 'cancelled';
          if (position > 0 || sample.position > 2) await this.call('command', { type: 'seek', value: position });
          if (operation !== this.operation) return 'cancelled';
          this.active = { request, track, source: selected, position, duration: sample.duration || selected.duration || 0,
            heard: 0, recorded: false, playing: true, audioId: sample.audioId };
          this.timer = setInterval(() => void this.observe(), 300);
          return 'playing';
        }
        if (sameTrack && !sample.playing && !resumed && selectedAt && Date.now() - selectedAt >= 900) {
          resumed = Boolean(await this.call('command', { type: 'play' }));
        }
        if (!selectedAt || (!retried && Date.now() - selectedAt > 1800 && !sameTrack)) {
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
    if (command.type === 'seek' || command.type === 'pause') {
      this.active.endedAt = undefined;
      this.active.handoffAt = undefined;
      if (command.type === 'seek') {
        this.active.position = command.value;
        this.active.seekUntil = Date.now() + 1000;
      }
    }
    return Boolean(await this.call('command', command));
  }

  async queueNext(request: number, track?: Track, reset = false) {
    const active = this.active;
    if (!active || active.request !== request) return;
    const version = (active.queueVersion ?? 0) + 1;
    active.queueVersion = version;
    const ready = () => this.active === active && active.queueVersion === version;
    if (reset) {
      active.next = undefined;
      for (let i = 0; i < 10 && ready(); i++) {
        if (await this.call('clearQueue')) break;
        await wait(100);
      }
    }
    if (!track || !ready()) return;
    const source = await findRecording(track);
    const id = source && octaveCatalogId(source.id);
    if (!id || !source || source.id === active.source.id || !ready()) return;
    let searched = false;
    const queries = octaveQueueQueries(source);
    for (let i = 0; ready() && i < queries.length * 8; i++) {
      if (i % 8 === 0) searched = false;
      if (await this.call<boolean>('queue', { id })) {
        if (!ready()) return;
        active.next = { track, source };
        return source.id;
      }
      if (!searched) searched = Boolean(await this.call('search', { query: queries[Math.floor(i / 8)] }));
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
      if (sample.position == null) return;
      if (sample.fading) {
        if (sample.outgoingPosition != null && sample.outgoingPosition >= active.position) active.position = sample.outgoingPosition;
        this.publish({request:active.request,time:active.position,duration:active.duration,
          playing:sample.playing,mixing:sample.mixing,upcoming:sample.upcoming});
        return;
      }
      let next: Track | undefined;
      let queuedTrackId: string | undefined;
      const planned = active.next;
      const currentMatches = matches(active.source, sample);
      const plannedMatches = !!planned && matches(planned.source, sample);
      const now = Date.now();
      if (sample.playing && now >= (active.seekUntil ?? 0) && octaveHandoff(active, { ...sample, position: sample.position })) {
        active.handoffAt = now;
      }
      if (active.handoffAt != null && now - active.handoffAt > 3500) active.handoffAt = undefined;
      if (sample.playing && active.handoffAt != null && (plannedMatches || (sample.title && !currentMatches))) {
        next = planned && plannedMatches ? planned.source : {
          id: octaveId(sample.id) ?? `octave:played-${encodeURIComponent([sample.title, sample.artist, sample.album].join('|'))}`,
          title: sample.title, artist: sample.artist, album: sample.album, artwork: sample.artwork, duration: sample.duration, square: true,
        };
        active.track = next === planned?.source ? planned.track : next;
        if (next === planned?.source) queuedTrackId = planned.track.id;
        active.source = next;
        active.next = undefined;
        active.handoffAt = undefined;
        active.queueVersion = (active.queueVersion ?? 0) + 1;
        active.heard = 0;
        active.recorded = false;
      }
      active.audioId = sample.audioId ?? active.audioId;
      if (sample.playing || sample.buffering) active.endedAt = undefined;
      else if (sample.ended || (active.playing && sample.duration > 0 && sample.duration - active.position < 1.5)) active.endedAt ??= Date.now();
      const ended = Boolean(active.endedAt && Date.now() - active.endedAt > 2500);
      const elapsed = sample.position - active.position;
      active.position = sample.position;
      active.duration = sample.duration || active.duration;
      active.playing = sample.playing;
      if (ended) await this.stop();
      this.publish({ request: active.request, time: sample.position, duration: active.duration, playing: sample.playing, track: next, queuedTrackId, ended,
        upcoming: sample.upcoming, mixing: sample.mixing });
      if (!next && active.handoffAt == null && !active.recorded && sample.audible && elapsed > 0 && elapsed < 2) {
        active.heard += elapsed;
        if (active.heard >= 5) {
          active.recorded = true;
          this.record({ ...active.track, artwork: active.track.artwork ?? active.source.artwork });
        }
      }
    } finally {
      this.observing = false;
    }
  }
}
