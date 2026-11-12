// AutoMix : analyse des titres (tempo, grille des temps, début et fin audibles, fondu de fin, niveau) et
// plan de transition, comme sur l'iPhone. Les mesures viennent soit du fichier audio complet (lecture directe),
// soit de l'écoute du lecteur de YouTube Music (le titre est alors entièrement connu après une écoute).

export interface TrackAnalysis {
  version: number;
  duration: number;
  /** Tempo ; absent quand la pulsation n'est pas nette. */
  bpm?: number;
  beatClarity: number;
  beatNearStart: number;
  beatNearEnd: number;
  audibleStart: number;
  audibleEnd: number;
  introEnd: number;
  outroStart: number;
  /** Niveau du corps du morceau (dB, valeur efficace). */
  loudness: number;
  /** Part du titre réellement mesurée (1 = entier). */
  coverage: number;
  /** Forme d'onde (120 niveaux de 0 à 35, en base 36) : barre de progression. */
  envelope?: string;
}

export interface MixPlan {
  outgoingId: string;
  incomingId: string;
  start: number;
  duration: number;
  incomingOffset: number;
  incomingRate: number;
  beatMatched: boolean;
  outgoingGain: number;
  incomingGain: number;
}

export const ANALYSIS_VERSION = 1;
export const HOP = 256;
const SIZE = 512;

// MARK: Mesures (niveau et flux spectral par tranche de 256 échantillons)

/** FFT réelle (radix 2) d'une fenêtre de 512 échantillons → magnitudes. */
function makeFFT(size: number) {
  const levels = Math.log2(size);
  const reverse = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    reverse[i] = r;
  }
  const cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / size); sin[i] = -Math.sin((2 * Math.PI * i) / size); }
  const re = new Float64Array(size), im = new Float64Array(size);
  return (input: ArrayLike<number>, magnitudes: Float64Array) => {
    for (let i = 0; i < size; i++) { re[reverse[i]] = input[i]; im[reverse[i]] = 0; }
    for (let half = 1; half < size; half *= 2) {
      const step = size / (half * 2);
      for (let start = 0; start < size; start += half * 2) {
        for (let k = 0; k < half; k++) {
          const tr = cos[k * step] * re[start + k + half] - sin[k * step] * im[start + k + half];
          const ti = cos[k * step] * im[start + k + half] + sin[k * step] * re[start + k + half];
          re[start + k + half] = re[start + k] - tr; im[start + k + half] = im[start + k] - ti;
          re[start + k] += tr; im[start + k] += ti;
        }
      }
    }
    for (let i = 0; i < size / 2; i++) magnitudes[i] = Math.hypot(re[i], im[i]);
  };
}

/** Mesure en continu : on lui donne des échantillons mono, elle rend (niveau, flux) toutes les 256 valeurs. */
export function createMeter(sampleRate: number) {
  const fft = makeFFT(SIZE);
  const window = new Float64Array(SIZE).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SIZE - 1)));
  const weights = new Float64Array(SIZE / 2).map((_, i) => ((i * sampleRate) / SIZE < 250 ? 3 : 1));
  const buffer = new Float64Array(SIZE), framed = new Float64Array(SIZE);
  const magnitudes = new Float64Array(SIZE / 2), previous = new Float64Array(SIZE / 2);
  let filled = 0, first = true;
  return (samples: ArrayLike<number>, emit: (rms: number, flux: number) => void) => {
    for (let i = 0; i < samples.length; i++) {
      buffer[filled++] = samples[i];
      if (filled < SIZE) continue;
      let energy = 0;
      for (let j = 0; j < SIZE; j++) { energy += buffer[j] * buffer[j]; framed[j] = buffer[j] * window[j]; }
      fft(framed, magnitudes);
      let flux = 0;
      for (let j = 1; j < SIZE / 2; j++) {
        const value = Math.log1p(100 * magnitudes[j]);
        const rise = value - previous[j];
        if (!first && rise > 0) flux += rise * weights[j];
        previous[j] = value;
      }
      first = false;
      emit(Math.sqrt(energy / SIZE), flux);
      buffer.copyWithin(0, HOP);
      filled = SIZE - HOP;
    }
  };
}

// MARK: Analyse

function movingAverage(values: ArrayLike<number>, width: number) {
  const prefix = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i] + values[i];
  const half = Math.floor(width / 2);
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const low = Math.max(0, i - half), high = Math.min(values.length, i + half + 1);
    out[i] = (prefix[high] - prefix[low]) / (high - low);
  }
  return out;
}

function gridSum(onsets: Float64Array, period: number, start: number, end: number) {
  let sum = 0;
  const last = Math.min(end, onsets.length) - 1;
  for (let p = start; p < last; p += period) {
    const i = Math.floor(p), f = p - i;
    sum += onsets[i] * (1 - f) + onsets[i + 1] * f;
  }
  return sum;
}

function phase(onsets: Float64Array, period: number, from: number, to: number) {
  let best = -Infinity, bestPhase = 0;
  for (let p = 0; p < period; p += 0.25) {
    const score = gridSum(onsets, period, from + p, Math.max(to, from + 1));
    if (score > best) { best = score; bestPhase = p; }
  }
  return from + bestPhase;
}

function tempo(onsets: Float64Array, frameRate: number): { bpm?: number; clarity: number } {
  const count = onsets.length;
  const maxLag = Math.floor((60 * frameRate / 70) * 4) + 6;
  if (count < maxLag * 3) return { clarity: 0 };
  let mean = 0;
  for (const v of onsets) mean += v;
  mean /= count;
  const centered = onsets.map((v) => v - mean);
  const correlation = new Float64Array(maxLag + 2);
  for (let lag = 0; lag < correlation.length; lag++) {
    let dot = 0;
    for (let i = 0; i + lag < count; i++) dot += centered[i] * centered[i + lag];
    correlation[lag] = dot;
  }
  const at = (lag: number) => {
    const i = Math.floor(lag), f = lag - i;
    return i + 1 < correlation.length ? correlation[i] * (1 - f) + correlation[i + 1] * f : 0;
  };
  let best = -Infinity, bestBpm = 120;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const period = (60 * frameRate) / bpm;
    const comb = at(period) + 0.5 * at(2 * period) + 0.33 * at(3 * period) + 0.25 * at(4 * period);
    const score = comb * Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    if (score > best) { best = score; bestBpm = bpm; }
  }
  if (!(best > 0)) return { clarity: 0 };
  let refined = -Infinity, refinedBpm = bestBpm;
  for (let bpm = bestBpm - 1.5; bpm <= bestBpm + 1.5; bpm += 0.02) {
    const period = (60 * frameRate) / bpm;
    for (let p = 0; p < period; p += 0.5) {
      const score = gridSum(onsets, period, p, count);
      if (score > refined) { refined = score; refinedBpm = bpm; }
    }
  }
  const period = (60 * frameRate) / refinedBpm;
  const sums: number[] = [];
  for (let p = 0; p < period; p += 0.5) sums.push(gridSum(onsets, period, p, count));
  const clarity = Math.max(...sums) / Math.max(sums.reduce((a, b) => a + b, 0) / sums.length, 1e-9);
  return { bpm: clarity >= 1.8 ? refinedBpm : undefined, clarity };
}

/** Analyse à partir des mesures (une valeur par tranche de 256 échantillons). */
export function analyzeMeasures(rms: ArrayLike<number>, flux: ArrayLike<number>, frameRate: number, duration: number, coverage = 1): TrackAnalysis {
  const frames = rms.length;
  const time = (frame: number) => frame / frameRate;
  const db = Array.from(rms, (v) => 20 * Math.log10(Math.max(v, 1e-9)));
  const peak = Math.max(...db);
  let firstAudible = db.findIndex((v) => v > peak - 45);
  if (firstAudible < 0) firstAudible = 0;
  let lastAudible = frames - 1;
  while (lastAudible > firstAudible && !(db[lastAudible] > peak - 45)) lastAudible--;
  const audibleStart = time(firstAudible);
  const audibleEnd = Math.min(duration, time(lastAudible) + SIZE / (frameRate * HOP));

  const width = Math.max(1, Math.round(frameRate));
  const smooth = Array.from(movingAverage(Array.from(rms, (v) => v * v), width), (v) => 10 * Math.log10(Math.max(v, 1e-12)));
  const body = smooth.slice(firstAudible, lastAudible + 1).sort((a, b) => a - b);
  const loudness = body.length ? body[Math.floor((body.length - 1) * 0.7)] : -60;
  let firstLoud = firstAudible;
  while (firstLoud < lastAudible && smooth[firstLoud] < loudness - 6) firstLoud++;
  let lastLoud = lastAudible;
  while (lastLoud > firstAudible && smooth[lastLoud] < loudness - 6) lastLoud--;

  const average = movingAverage(flux, width);
  const onsets = new Float64Array(frames);
  for (let i = 0; i < frames; i++) onsets[i] = Math.max(0, flux[i] - average[i]);
  const { bpm, clarity } = tempo(onsets, frameRate);
  let beatNearStart = audibleStart, beatNearEnd = Math.max(audibleStart, audibleEnd - 30);
  if (bpm) {
    const period = (60 * frameRate) / bpm;
    beatNearStart = phase(onsets, period, firstAudible, Math.min(lastAudible, firstAudible + Math.round(30 * frameRate))) / frameRate;
    beatNearEnd = phase(onsets, period, Math.max(firstAudible, lastAudible - Math.round(30 * frameRate)), lastAudible) / frameRate;
  }
  return {
    version: ANALYSIS_VERSION, duration, bpm, beatClarity: clarity, beatNearStart, beatNearEnd,
    audibleStart, audibleEnd, introEnd: time(firstLoud), outroStart: time(lastLoud), loudness, coverage,
    envelope: envelope(rms, frameRate, duration),
  };
}

/** Forme d'onde du titre en 120 niveaux (niveau sonore lissé, sur 36 dB sous le maximum). */
export function envelope(rms: ArrayLike<number>, frameRate: number, duration: number, buckets = 120) {
  const total = Math.max(1, Math.round(duration * frameRate));
  const levels: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b / buckets) * total), to = Math.max(from + 1, Math.floor(((b + 1) / buckets) * total));
    let energy = 0, n = 0;
    for (let i = from; i < to && i < rms.length; i++) { energy += rms[i] * rms[i]; n++; }
    levels.push(n ? 10 * Math.log10(Math.max(energy / n, 1e-12)) : -120);
  }
  const peak = Math.max(...levels);
  return levels.map((db) => Math.round(Math.min(1, Math.max(0, (db - (peak - 36)) / 36)) * 35).toString(36)).join('');
}

export function decodeEnvelope(text: string) {
  return Array.from(text, (c) => parseInt(c, 36) / 35);
}

/** Analyse d'un fichier audio complet (échantillons mono). */
export function analyzeSamples(samples: Float32Array, sampleRate: number): TrackAnalysis {
  const rms: number[] = [], flux: number[] = [];
  createMeter(sampleRate)(samples, (r, f) => { rms.push(r); flux.push(f); });
  return analyzeMeasures(rms, flux, sampleRate / HOP, samples.length / sampleRate);
}

// MARK: Grille des temps

const period = (a: TrackAnalysis) => (a.bpm ? 60 / a.bpm : undefined);
const anchor = (a: TrackAnalysis, time: number) => (time < a.duration / 2 ? a.beatNearStart : a.beatNearEnd);

export function nearestBeat(a: TrackAnalysis, time: number) {
  const p = period(a);
  if (!p) return time;
  const origin = anchor(a, time);
  return origin + Math.round((time - origin) / p) * p;
}

export function beatOnOrAfter(a: TrackAnalysis, time: number) {
  const p = period(a);
  if (!p) return time;
  const origin = anchor(a, time);
  return origin + Math.ceil((time - origin) / p - 0.02) * p;
}

// MARK: Plan de transition

export const LOUDNESS_TARGET = -11;

export function gainFor(a: TrackAnalysis | undefined, normalize: boolean) {
  if (!normalize || !a || a.coverage < 0.6) return 1;
  return Math.min(1, 10 ** ((LOUDNESS_TARGET - a.loudness) / 20));
}

/** Volumes (entrant, sortant) à l'instant t (0 → 1) : puissance constante, courbe douce. */
export function mixVolumes(t: number) {
  const x = Math.min(Math.max(t, 0), 1);
  const u = x * x * (3 - 2 * x);
  return [Math.sin((Math.PI / 2) * u), Math.cos((Math.PI / 2) * u)] as const;
}

/** Échange des basses (façon DJ) : basses de l'entrant coupées au début, celles du sortant coupées à la fin (dB). */
export function bassSwap(t: number) {
  const ramp = (x: number) => Math.min(Math.max(x, 0), 1);
  const incoming = -24 * (1 - ramp((t - 0.35) / 0.2));
  const outgoing = -24 * ramp((t - 0.45) / 0.2);
  return [incoming, outgoing] as const;
}

export function planMix(outgoingId: string, a: TrackAnalysis, incomingId: string, b: TrackAnalysis, normalize: boolean): MixPlan {
  let rate = 1;
  let matched = false;
  if (a.bpm && b.bpm) {
    let ratio = a.bpm / b.bpm;
    while (ratio > 1.41) ratio /= 2;
    while (ratio < 0.71) ratio *= 2;
    if (Math.abs(ratio - 1) <= 0.08) { rate = ratio; matched = true; }
  }
  let duration = 8;
  const p = period(a);
  if (matched && p) {
    duration = 16 * p;
    if (duration < 6) duration = 32 * p;
    if (duration > 14) duration = 8 * p;
  }
  // Fin connue seulement si le titre sortant a été mesuré jusqu'au bout.
  const end = a.coverage >= 0.95 ? a.audibleEnd : a.duration;
  const fade = a.coverage >= 0.95 ? a.audibleEnd - a.outroStart : 0;
  let start: number;
  if (fade >= 4) {
    start = a.outroStart - (matched ? duration * 0.25 : 0);
    duration = Math.min(Math.max(duration, Math.min(fade, 14)), end - start);
  } else {
    start = end - duration;
  }
  start = Math.max(start, Math.min(end - 4, Math.max(20, a.duration * 0.5)));
  if (matched) start = nearestBeat(a, start);
  duration = Math.max(3, Math.min(duration, end - start + 0.5));
  let offset = Math.max(0, b.audibleStart - 0.02);
  if (matched && b.bpm) {
    offset = Math.max(0, beatOnOrAfter(b, b.audibleStart - 0.05));
    if (offset - b.audibleStart > 2) offset = Math.max(0, b.audibleStart - 0.02);
  }
  return {
    outgoingId, incomingId, start, duration, incomingOffset: offset, incomingRate: rate, beatMatched: matched,
    outgoingGain: gainFor(a, normalize), incomingGain: gainFor(b, normalize),
  };
}

// MARK: Analyses gardées (une fois par titre)

const stored: Record<string, TrackAnalysis> = (() => {
  try { return JSON.parse(localStorage.getItem('analyses') ?? '{}'); } catch { return {}; }
})();

export function savedAnalysis(id: string): TrackAnalysis | undefined {
  const found = stored[id];
  return found?.version === ANALYSIS_VERSION ? found : undefined;
}

export function saveAnalysis(id: string, analysis: TrackAnalysis) {
  const previous = stored[id];
  if (previous && previous.coverage > analysis.coverage) return;
  delete stored[id];
  stored[id] = analysis;
  const keys = Object.keys(stored);
  if (keys.length > 3000) for (const key of keys.slice(0, keys.length - 3000)) delete stored[key];
  try { localStorage.setItem('analyses', JSON.stringify(stored)); } catch { /* stockage plein : tant pis */ }
}
