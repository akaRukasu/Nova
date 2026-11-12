// Égaliseur (PC et Android) : cinq bandes, préréglages façon Apple Music / Spotify.
// Le son passe par le même circuit dans la lecture directe et dans le lecteur de YouTube Music.

export const EQ_FREQUENCIES = [60, 250, 1000, 4000, 12000];

export const EQ_PRESETS: { id: string; label: string; bands: number[] }[] = [
  { id: 'off', label: 'Désactivé (son d’origine)', bands: [0, 0, 0, 0, 0] },
  { id: 'enhance', label: 'Amélioration du son', bands: [2.5, 0.5, -0.5, 1, 2.5] },
  { id: 'bass', label: 'Basses renforcées', bands: [5, 2, 0, 0, 0] },
  { id: 'treble', label: 'Aigus plus clairs', bands: [0, 0, 0, 2, 4] },
  { id: 'vocal', label: 'Voix en avant', bands: [-2, -1, 2, 3, 0.5] },
  { id: 'loudness', label: 'Faible volume (loudness)', bands: [4.5, 1.5, 0, 1, 3.5] },
  { id: 'rock', label: 'Rock', bands: [3, 1, -1, 2, 3] },
  { id: 'electro', label: 'Électro', bands: [4, 1.5, -0.5, 1, 2.5] },
  { id: 'hiphop', label: 'Hip-hop', bands: [4.5, 2, -0.5, 1, 1] },
  { id: 'acoustic', label: 'Acoustique', bands: [1, 1, 0.5, 1.5, 2] },
];

export function eqBands(id: string | undefined) {
  return (EQ_PRESETS.find((preset) => preset.id === id) ?? EQ_PRESETS[0]).bands;
}

/** Chaîne de filtres entre `input` et `output`, avec une légère baisse de volume pour ne jamais saturer. */
export function createChain(context: BaseAudioContext, input: AudioNode, output: AudioNode) {
  const filters = EQ_FREQUENCIES.map((frequency, i) => {
    const filter = context.createBiquadFilter();
    filter.type = i === 0 ? 'lowshelf' : i === EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking';
    filter.frequency.value = frequency;
    filter.Q.value = 1;
    filter.gain.value = 0;
    return filter;
  });
  const preamp = context.createGain();
  filters.reduce<AudioNode>((previous, filter) => previous.connect(filter), input).connect(preamp).connect(output);
  return {
    set(bands: number[]) {
      bands.forEach((gain, i) => filters[i].gain.setTargetAtTime(gain, context.currentTime, 0.05));
      const boost = Math.max(0, ...bands);
      preamp.gain.setTargetAtTime(10 ** (-(boost * 0.7) / 20), context.currentTime, 0.05);
    },
  };
}
