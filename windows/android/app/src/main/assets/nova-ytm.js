// Script injecté dans la page du lecteur YouTube Music (WebView invisible) : il pilote l'élément vidéo
// de la page (lecture, pause, position, volume) et renvoie son état à Nova.
(function () {
  if (window.__nova) return;
  var expected = '', volume = 0.8, video = null, lastSent = 0;
  function currentId() { try { return new URL(location.href).searchParams.get('v') || ''; } catch (e) { return ''; } }
  function isAd() {
    if (document.querySelector('#movie_player.ad-showing, .ad-showing, .ad-interrupting')) return true;
    var ui = document.querySelectorAll('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-preview-container, .ytp-ad-simple-ad-badge, .ytp-ad-badge, .ytp-ad-duration-remaining, .ytp-ad-skip-button-container');
    for (var i = 0; i < ui.length; i++) if (ui[i].offsetParent !== null) return true;
    return false;
  }
  function report(type) {
    if (!video) return;
    NovaBridge.post(JSON.stringify({
      type: type, time: video.currentTime, duration: isFinite(video.duration) ? video.duration : 0,
      paused: video.paused, ad: isAd(), videoId: currentId(), expected: expected
    }));
  }
  function applyVolume() { if (video && Math.abs(video.volume - volume) > 0.01) video.volume = volume; }
  function attach(element) {
    if (video === element) return;
    video = element;
    element.addEventListener('playing', function () {
      // YouTube Music enchaîne seul sur son titre suivant : Nova garde la main sur la file.
      if (expected && currentId() && currentId() !== expected && !isAd()) { element.pause(); return; }
      applyVolume();
      report('playing');
    });
    element.addEventListener('pause', function () { report('pause'); });
    element.addEventListener('waiting', function () { report('waiting'); });
    element.addEventListener('ended', function () { if (!isAd()) report('ended'); });
    element.addEventListener('error', function () { report('error'); });
    element.addEventListener('loadedmetadata', function () { applyVolume(); report('loadedmetadata'); });
    element.addEventListener('volumechange', applyVolume);
    if (!element.paused) setTimeout(function () { report('playing'); }, 0);
    element.addEventListener('timeupdate', function () {
      if (Date.now() - lastSent < 240) return;
      lastSent = Date.now();
      report('timeupdate');
    });
  }
  // AutoMix : écoute du titre (tempo, temps, fin), tempo réglable, filtre des basses (même calcul que dans Nova).
  function createMeter(sampleRate) {
    var size = 512, hop = 256, i, reverse = new Uint32Array(size);
    for (i = 0; i < size; i++) { var r = 0; for (var b = 0; b < 9; b++) r |= ((i >> b) & 1) << (8 - b); reverse[i] = r; }
    var cos = new Float64Array(size / 2), sin = new Float64Array(size / 2), win = new Float64Array(size), weights = new Float64Array(size / 2);
    for (i = 0; i < size / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / size); sin[i] = -Math.sin(2 * Math.PI * i / size); weights[i] = i * sampleRate / size < 250 ? 3 : 1; }
    for (i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1));
    var buffer = new Float64Array(size), re = new Float64Array(size), im = new Float64Array(size), previous = new Float64Array(size / 2);
    var filled = 0, first = true;
    return function (samples, emit) {
      for (var s = 0; s < samples.length; s++) {
        buffer[filled++] = samples[s];
        if (filled < size) continue;
        var energy = 0;
        for (var j = 0; j < size; j++) { energy += buffer[j] * buffer[j]; re[reverse[j]] = buffer[j] * win[j]; im[reverse[j]] = 0; }
        for (var half = 1; half < size; half *= 2) {
          var step = size / (half * 2);
          for (var start = 0; start < size; start += half * 2) {
            for (var k = 0; k < half; k++) {
              var a = start + k, c2 = a + half, c = cos[k * step], d = sin[k * step];
              var tr = c * re[c2] - d * im[c2], ti = c * im[c2] + d * re[c2];
              re[c2] = re[a] - tr; im[c2] = im[a] - ti; re[a] += tr; im[a] += ti;
            }
          }
        }
        var flux = 0;
        for (var m = 1; m < size / 2; m++) {
          var value = Math.log1p(100 * Math.hypot(re[m], im[m]));
          if (!first && value > previous[m]) flux += (value - previous[m]) * weights[m];
          previous[m] = value;
        }
        first = false;
        emit(s, Math.sqrt(energy / size), flux);
        buffer.copyWithin(0, hop);
        filled = size - hop;
      }
    };
  }
  var audio = null, measures = [], eqBands = [0, 0, 0, 0, 0];
  function applyEqualizer() {
    if (!audio || !audio.eq) return;
    var now = audio.context.currentTime;
    for (var i = 0; i < audio.eq.length; i++) audio.eq[i].gain.setTargetAtTime(eqBands[i] || 0, now, 0.05);
    audio.preamp.gain.setTargetAtTime(Math.pow(10, -(Math.max.apply(null, [0].concat(eqBands)) * 0.7) / 20), now, 0.05);
  }
  function setupAudio(element) {
    if (audio && audio.element === element) return;
    try {
      var context = new (window.AudioContext || window.webkitAudioContext)();
      var source = context.createMediaElementSource(element);
      var bass = context.createBiquadFilter();
      bass.type = 'lowshelf'; bass.frequency.value = 200; bass.gain.value = 0;
      var mute = context.createGain(), preamp = context.createGain(), eq = [], previous = bass;
      source.connect(bass);
      [60, 250, 1000, 4000, 12000].forEach(function (frequency, i) {
        var filter = context.createBiquadFilter();
        filter.type = i === 0 ? 'lowshelf' : i === 4 ? 'highshelf' : 'peaking';
        filter.frequency.value = frequency; filter.Q.value = 1;
        previous.connect(filter); previous = filter; eq.push(filter);
      });
      previous.connect(preamp); preamp.connect(mute); mute.connect(context.destination);
      var tap = context.createScriptProcessor(2048, 2, 1);
      var factor = Math.max(1, Math.round(context.sampleRate / 11025)), rate = context.sampleRate / factor;
      var meter = createMeter(rate), reduced = new Float32Array(Math.ceil(2048 / factor));
      tap.onaudioprocess = function (event) {
        event.outputBuffer.getChannelData(0).fill(0);
        if (!video || video.paused || isAd() || Math.abs(video.playbackRate - 1) > 0.001) return;
        var left = event.inputBuffer.getChannelData(0);
        var right = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : left;
        var n = 0;
        for (var i = 0; i + factor <= left.length; i += factor) {
          var sum = 0;
          for (var j = 0; j < factor; j++) sum += left[i + j] + right[i + j];
          reduced[n++] = sum / (2 * factor);
        }
        var blockStart = video.currentTime - left.length / context.sampleRate;
        meter(reduced.subarray(0, n), function (index, rms, flux) {
          var time = blockStart + (index + 1 - 512) / rate;
          if (time >= 0) measures.push([Math.round(time * 1000) / 1000, rms, flux]);
        });
      };
      source.connect(tap); tap.connect(context.destination);
      context.resume();
      audio = { element: element, context: context, bass: bass, mute: mute, eq: eq, preamp: preamp, frameRate: rate / 256 };
      applyEqualizer();
    } catch (e) {
      audio = { element: element, context: null, bass: null };
    }
  }
  setInterval(function () {
    if (!measures.length || !audio || !audio.context) return;
    NovaBridge.post(JSON.stringify({ type: 'measures', videoId: currentId(), expected: expected, frameRate: audio.frameRate, frames: measures }));
    measures = [];
  }, 1000);

  // Publicités : son coupé pendant qu'elles passent, et « Passer » pressé dès que YouTube le propose.
  var skipButtons = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, button[id^="skip-button"]';
  var mutedForAd = false;
  function handleAds() {
    if (!video) return;
    var ad = isAd(), videos = document.querySelectorAll('video'), i;
    if (audio && audio.mute) audio.mute.gain.value = ad ? 0 : 1;
    if (ad) {
      for (i = 0; i < videos.length; i++) if (!videos[i].muted) { videos[i].muted = true; mutedForAd = true; }
      var skip = document.querySelector(skipButtons);
      if (skip && skip.offsetParent !== null) skip.click();
    } else if (mutedForAd) {
      for (i = 0; i < videos.length; i++) videos[i].muted = false;
      mutedForAd = false;
    }
  }
  setInterval(handleAds, 100);

  setInterval(function () {
    var found = document.querySelector('video');
    if (found) attach(found);
    if (found && !found.paused) setupAudio(found);
    handleAds();
  }, 300);
  window.__nova = {
    expect: function (id, level) { expected = id || ''; if (level != null) volume = level; applyVolume(); },
    command: function (c) {
      if (c.type === 'play' && video) video.play().catch(function () { report('error'); });
      if (c.type === 'pause' && video) video.pause();
      if (c.type === 'seek' && video && c.value != null) video.currentTime = c.value;
      if (c.type === 'volume') { if (c.value != null) volume = c.value; applyVolume(); }
      if (c.type === 'stop') { expected = ''; if (video) video.pause(); }
      if (c.type === 'rate' && video && c.value) { video.preservesPitch = true; video.playbackRate = c.value; }
      if (c.type === 'eq' && c.bands) { eqBands = c.bands; applyEqualizer(); }
      if (c.type === 'bass' && audio && audio.bass && c.value != null) audio.bass.gain.setTargetAtTime(c.value, audio.context.currentTime, 0.05);
    }
  };
})();
