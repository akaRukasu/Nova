// Script injecté dans la page du lecteur YouTube Music (WebView invisible) : il pilote l'élément vidéo
// de la page (lecture, pause, position, volume) et renvoie son état à Nova.
(function () {
  if (window.__nova) return;
  var expected = '', volume = 0.8, video = null, lastSent = 0;
  function currentId() { try { return new URL(location.href).searchParams.get('v') || ''; } catch (e) { return ''; } }
  function isAd() { return !!document.querySelector('#movie_player.ad-showing, .ad-showing, .ytp-ad-player-overlay'); }
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
  setInterval(function () { var found = document.querySelector('video'); if (found) attach(found); }, 300);
  window.__nova = {
    expect: function (id, level) { expected = id || ''; if (level != null) volume = level; applyVolume(); },
    command: function (c) {
      if (c.type === 'play' && video) video.play().catch(function () { report('error'); });
      if (c.type === 'pause' && video) video.pause();
      if (c.type === 'seek' && video && c.value != null) video.currentTime = c.value;
      if (c.type === 'volume') { if (c.value != null) volume = c.value; applyVolume(); }
      if (c.type === 'stop') { expected = ''; if (video) video.pause(); }
    }
  };
})();
