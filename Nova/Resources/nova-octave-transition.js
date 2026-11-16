(() => {
  'use strict';
  if (location.origin !== 'https://music.octavestreaming.com' || window.novaOctaveTransition) return;
  // Le plan appartient au moteur Octave. Une interrogation ne doit jamais
  // remplacer son AutoMix par un fondu fixe en pleine lecture.
  Object.defineProperty(window, 'novaOctaveTransition', {
    value: track => {
      const preview = window.__octaveAutomix?.preview;
      return String(preview?.trackId) === String(track) ? preview : null;
    },
  });
})();
