(() => {
  'use strict';
  if (location.origin !== 'https://music.octavestreaming.com' || window.novaOctaveTransition) return;

  let pending;
  let chosen;
  let retryAt = 0;

  // Octave exposes its plan before the transition. Choose its own per-track crossfade
  // from the menu when that plan would only trim silence or use a very short overlap.
  function selectTransition(track, position, pair = '') {
    const preview = window.__octaveAutomix?.preview;
    const key = String(track) + '|' + pair;
    const close = () => {
      if (pending?.button.getAttribute('aria-expanded') === 'true') pending.button.click();
      pending = undefined;
    };
    if (chosen !== key) chosen = undefined;
    if (String(preview?.trackId) !== String(track) || !Number.isFinite(position) ||
        !Number.isFinite(preview?.openAt) || !Number.isFinite(preview?.seamEnd) ||
        preview.seamEnd - position < 7.5 || preview.openAt - position < 0.8 ||
        preview.openAt - position > 32 || (preview.mixes && preview.seamEnd - preview.openAt >= 3.5)) {
      close();
      return;
    }
    if (pending && pending.key !== key) close();
    if (chosen === key || Date.now() < retryAt) return;

    const button = pending?.button ?? [...document.querySelectorAll('button[aria-label="Song transitions: AutoMix"]')]
      .find(control => control.getClientRects().length);
    if (!button) return;
    if (!pending) {
      if (button.getAttribute('aria-expanded') === 'true') return;
      button.click();
      pending = { key, button, deadline: Date.now() + 700 };
      return;
    }
    const menu = [...document.querySelectorAll('p')].find(label => label.textContent === 'Next Transition')?.parentElement;
    const options = [...menu?.querySelectorAll('button') ?? []];
    const labelOf = button => button.querySelector('span span')?.textContent;
    const automatic = options.find(button => labelOf(button) === 'Automatic');
    const crossfade = options.find(button => labelOf(button) === 'Crossfade' && /^[4-9] s$/.test(button.querySelector('span span + span')?.textContent ?? ''));
    if (automatic && crossfade && button.getAttribute('aria-expanded') === 'true') {
      if (automatic.textContent.includes('✓')) crossfade.click();
      else close(); // Keep a transition the listener already chose.
      chosen = key;
      pending = undefined;
    } else if (Date.now() > pending.deadline) {
      close();
      retryAt = Date.now() + 2000;
    }
  }

  Object.defineProperty(window, 'novaOctaveTransition', { value: selectTransition });
})();
