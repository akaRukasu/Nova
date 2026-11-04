// Avant l'initialisation des patches : conserver ensuite les choix de l'utilisateur.
try {
  const saved = JSON.parse(localStorage.getItem("VencordSettings") || "{}");
  saved.plugins ||= {};
  for (const name of ["FakeNitro", "WebScreenShare", "WebScreenShareFixes", "WebKeybinds"]) {
    saved.plugins[name] = { enabled: true, ...saved.plugins[name] };
  }
  saved.plugins.FakeNitro = { enableStreamQualityBypass: true, ...saved.plugins.FakeNitro };
  saved.plugins.WebScreenShare = { resolution: "1080", frameRate: "60", ...saved.plugins.WebScreenShare };
  // La PWA suppose une extension Chrome pour les raccourcis ; NovaCord utilise Windows.
  saved.plugins.WebPWA = { enabled: false, ...saved.plugins.WebPWA };
  localStorage.setItem("VencordSettings", JSON.stringify(saved));
} catch (error) {
  console.error("NovaCord : réglages Vencord illisibles", error);
}
