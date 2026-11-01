/*
 * NovaCord : couche de mods injectée dans Discord avant ses propres scripts.
 *
 * Les fonctions Discord sont fournies par Vencord ; ce panneau gère aussi
 * les raccourcis Windows et la soundboard dans le flux du microphone.
 */
(() => {
  "use strict";
  if (window.NovaCord || window.top !== window) return;
  if (!/(^|\.)discord(app)?\.com$/.test(location.hostname)) return;

  // Discord retire window.localStorage au démarrage : on le garde de côté.
  const storage = window.localStorage;
  const KEY = "novacord:settings";
  const SEEN_KEY = "novacord:welcome";
  const HOTKEY_LABEL = "Ctrl + Alt + N";
  const invoke = (command, args) => {
    if (!window.__TAURI__?.core?.invoke) return Promise.reject(new Error("La liaison Windows n'est pas disponible."));
    return window.__TAURI__.core.invoke(command, args);
  };
  let voiceActions = {};
  window.Vencord?.Webpack.waitFor(["dispatch", "subscribe"], (dispatcher) => {
    dispatcher.subscribe("KEYBINDS_REGISTER_GLOBAL_KEYBIND_ACTIONS", ({ keybinds }) => { voiceActions = keybinds; });
  });
  let recording = null;
  let recordingTimer;

  function notifyError(error) {
    const message = String(error?.message || error);
    if (!document.body) return console.error(message);
    const { h, root } = makeHost();
    root.append(el("div", { class: "toast", role: "alert" }, message));
    setTimeout(() => h.remove(), 7000);
  }

  async function runShortcut(action) {
    try {
      if (action === "panel") return openPanel();
      if (action === "stopSounds") return window.NovaCordAudio.stopAll();
      if (action.startsWith("sound:")) return await window.NovaCordAudio.play(action.slice(6));
      if (!voiceActions[action]?.onTrigger) throw new Error("L'action vocale n'est pas encore prête. Connecte-toi à Discord.");
      voiceActions[action].onTrigger();
    } catch (error) { notifyError(error); }
  }

  async function stopRecording() {
    clearTimeout(recordingTimer);
    if (recording) recording.button.textContent = recording.binding.accelerator || "Enregistrer les touches";
    recording = null;
    await invoke("set_shortcut_recording", { active: false }).catch(notifyError);
  }

  function captureShortcut(accelerator) {
    if (!recording) return;
    const { binding, button } = recording;
    binding.accelerator = accelerator;
    button.textContent = accelerator;
    stopRecording();
  }

  async function beginRecording(binding, button) {
    await stopRecording();
    try {
      await invoke("set_shortcut_recording", { active: true });
      recording = { binding, button };
      button.textContent = "Appuie sur les touches… (Échap pour annuler)";
      button.focus();
      recordingTimer = setTimeout(() => { button.textContent = binding.accelerator || "Enregistrer les touches"; stopRecording(); }, 30000);
    } catch (error) { notifyError(error); }
  }

  /* ------------------------------------------------------------------ */
  /* Plugins                                                             */
  /* ------------------------------------------------------------------ */

  const PLUGINS = [
    {
      id: "noTrack",
      name: "Anti-pistage",
      description:
        "Bloque la télémétrie de Discord (science, metrics, Sentry). Moins de requêtes, moins de données envoyées.",
      default: true,
    },
    {
      id: "ecoMode",
      name: "Mode éco",
      description:
        "Coupe les animations, transitions et flous d'arrière-plan. Soulage le processeur et la carte graphique.",
      default: true,
    },
    {
      id: "hideNitro",
      name: "Masquer les pubs Nitro",
      description:
        "Cache le bouton cadeau, l'onglet Nitro, la boutique et les quêtes.",
      default: true,
    },
    {
      id: "clearUrls",
      name: "Liens propres",
      description:
        "Retire les paramètres de pistage (utm_, fbclid, si…) des liens que tu envoies.",
      default: true,
    },
    {
      id: "silentTyping",
      name: "Frappe invisible",
      description:
        "Les autres ne voient plus « … est en train d'écrire ».",
      default: false,
    },
    {
      id: "noReplyMention",
      name: "Réponses sans mention",
      description:
        "Quand tu réponds à un message, l'auteur n'est plus mentionné par défaut.",
      default: false,
    },
    {
      id: "compact",
      name: "Interface compacte",
      description:
        "Réduit les marges de la liste des salons et des messages pour afficher plus de contenu.",
      default: false,
    },
  ];

  const THEMES = {
    default: { name: "Discord (par défaut)", css: "" },
    amoled: {
      name: "AMOLED (noir pur)",
      css: themeVars({
        bg1: "#000000",
        bg2: "#050505",
        bg3: "#0b0b0c",
        bg4: "#121214",
        hover: "#161618",
        input: "#0e0e10",
      }),
    },
    midnight: {
      name: "Minuit (bleu nuit)",
      css: themeVars({
        bg1: "#0f1320",
        bg2: "#121726",
        bg3: "#161c2e",
        bg4: "#1b2237",
        hover: "#222a43",
        input: "#141a2b",
      }),
    },
    nord: {
      name: "Nord",
      css: themeVars({
        bg1: "#2e3440",
        bg2: "#333a47",
        bg3: "#3b4252",
        bg4: "#434c5e",
        hover: "#4c566a",
        input: "#3b4252",
      }),
    },
  };

  // Couvre les anciens et les nouveaux noms de variables de couleur de Discord.
  function themeVars(c) {
    return `
      .theme-dark, .theme-darker, .theme-midnight, :root {
        --background-primary: ${c.bg3} !important;
        --background-secondary: ${c.bg2} !important;
        --background-secondary-alt: ${c.bg2} !important;
        --background-tertiary: ${c.bg1} !important;
        --background-floating: ${c.bg1} !important;
        --background-nested-floating: ${c.bg2} !important;
        --background-mobile-primary: ${c.bg3} !important;
        --background-mobile-secondary: ${c.bg2} !important;
        --background-modifier-hover: ${c.hover} !important;
        --channeltextarea-background: ${c.input} !important;
        --modal-background: ${c.bg2} !important;
        --modal-footer-background: ${c.bg1} !important;
        --chat-background: ${c.bg3} !important;
        --background-base-lowest: ${c.bg1} !important;
        --background-base-lower: ${c.bg2} !important;
        --background-base-low: ${c.bg3} !important;
        --background-surface-high: ${c.bg4} !important;
        --background-surface-higher: ${c.bg4} !important;
        --background-surface-highest: ${c.hover} !important;
        --bg-base-primary: ${c.bg3} !important;
        --bg-base-secondary: ${c.bg2} !important;
        --bg-base-tertiary: ${c.bg1} !important;
        --bg-overlay-1: ${c.bg2} !important;
        --bg-overlay-2: ${c.bg2} !important;
        --bg-overlay-3: ${c.bg3} !important;
        --bg-overlay-chat: ${c.bg3} !important;
        --bg-overlay-floating: ${c.bg1} !important;
        --input-background: ${c.input} !important;
      }`;
  }

  const PLUGIN_CSS = {
    ecoMode: `
      /* 0.01ms et non 0s : les événements de fin d'animation doivent
         toujours se déclencher, sinon certaines fenêtres restent bloquées. */
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-delay: 0s !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }
      * { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }`,
    hideNitro: `
      a[href="/store"], a[href="/shop"], a[href^="/discovery/quests"],
      a[href="/quest-home"], li:has(> div > a[href="/store"]),
      li:has(> div > a[href="/shop"]), li:has(a[href="/quest-home"]),
      button[aria-label="Envoyer un cadeau"], button[aria-label="Send a gift"],
      button[aria-label="Offrir Nitro"], button[aria-label="Gift Nitro"],
      [class*="premiumTrialAcknowledgedBadge"], [class*="nitroWheel"],
      [class*="upsellBanner"], [class*="premiumUpsell"] {
        display: none !important;
      }`,
    compact: `
      [class*="containerDefault"] { padding-top: 0 !important; padding-bottom: 0 !important; }
      [class*="cozyMessage"], [class*="groupStart"] { margin-top: 6px !important; }
      [class*="message_"][class*="cozy"] { padding-top: 1px !important; padding-bottom: 1px !important; }`,
  };

  /* ------------------------------------------------------------------ */
  /* Réglages                                                            */
  /* ------------------------------------------------------------------ */

  function loadSettings() {
    const base = { plugins: {}, theme: "default", customCss: "" };
    for (const p of PLUGINS) base.plugins[p.id] = p.default;
    try {
      const saved = JSON.parse(storage.getItem(KEY) || "{}");
      return {
        ...base,
        ...saved,
        plugins: { ...base.plugins, ...(saved.plugins || {}) },
      };
    } catch {
      return base;
    }
  }

  const settings = loadSettings();
  const enabled = (id) => !!settings.plugins[id];

  function saveSettings() {
    try {
      storage.setItem(KEY, JSON.stringify(settings));
    } catch {}
  }

  /* ------------------------------------------------------------------ */
  /* Réseau : télémétrie, frappe, nettoyage des liens, mentions         */
  /* ------------------------------------------------------------------ */

  const TRACKING_URL =
    /\/api\/v\d+\/(science|metrics|track)\b|sentry\.io|\/error-reporting-proxy\//;
  const TYPING_URL = /\/api\/v\d+\/channels\/\d+\/typing$/;
  const MESSAGE_URL = /\/api\/v\d+\/channels\/\d+\/messages(\/\d+)?$/;

  const TRACKING_PARAMS = [
    /^utm_/i,
    /^(fbclid|gclid|dclid|msclkid|yclid|mc_eid|mc_cid|igshid|igsh)$/i,
    /^(ref_src|ref_url|s_cid|_hsenc|_hsmi|mkt_tok|vero_id|wickedid|oly_enc_id|oly_anon_id)$/i,
    /^(si|feature|pp)$/i, // YouTube / Spotify
    /^(spm|scm|share_id|share_source|ttclid|twclid)$/i,
  ];

  function cleanUrl(raw) {
    try {
      const url = new URL(raw);
      let changed = false;
      for (const key of [...url.searchParams.keys()]) {
        if (TRACKING_PARAMS.some((re) => re.test(key))) {
          url.searchParams.delete(key);
          changed = true;
        }
      }
      return changed ? url.toString().replace(/\?$/, "") : raw;
    } catch {
      return raw;
    }
  }

  function cleanContent(text) {
    return text.replace(/https?:\/\/[^\s<>()]+/g, cleanUrl);
  }

  function patchMessagePayload(payload) {
    let touched = false;
    if (enabled("clearUrls") && typeof payload.content === "string") {
      const cleaned = cleanContent(payload.content);
      if (cleaned !== payload.content) {
        payload.content = cleaned;
        touched = true;
      }
    }
    if (enabled("noReplyMention") && payload.message_reference) {
      payload.allowed_mentions = {
        ...(payload.allowed_mentions || { parse: ["users", "roles", "everyone"] }),
        replied_user: false,
      };
      touched = true;
    }
    return touched;
  }

  // Retourne { block: true } ou { body } (corps modifié) ou null.
  function inspect(method, url, body) {
    method = String(method || "GET").toUpperCase();
    url = String(url || "");

    if (enabled("noTrack") && TRACKING_URL.test(url)) return { block: true };
    if (enabled("silentTyping") && method === "POST" && TYPING_URL.test(url)) {
      return { block: true };
    }
    if ((method === "POST" || method === "PATCH") && MESSAGE_URL.test(url)) {
      try {
        if (typeof body === "string") {
          const payload = JSON.parse(body);
          if (patchMessagePayload(payload)) return { body: JSON.stringify(payload) };
        } else if (body instanceof FormData && body.has("payload_json")) {
          const payload = JSON.parse(body.get("payload_json"));
          if (patchMessagePayload(payload)) {
            body.set("payload_json", JSON.stringify(payload));
            return { body };
          }
        }
      } catch {}
    }
    return null;
  }

  // fetch
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init && init.method) || (input instanceof Request ? input.method : "GET");
      const verdict = inspect(method, url, init && init.body);
      if (verdict && verdict.block) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (verdict && verdict.body !== undefined) init = { ...init, body: verdict.body };
    } catch {}
    return nativeFetch.call(this, input, init);
  };

  // XMLHttpRequest (utilisé par la plupart des appels d'API de Discord)
  const XHR = XMLHttpRequest.prototype;
  const nativeOpen = XHR.open;
  const nativeSend = XHR.send;
  XHR.open = function (method, url) {
    this.__nova = { method, url: String(url) };
    return nativeOpen.apply(this, arguments);
  };
  XHR.send = function (body) {
    const req = this.__nova;
    if (req) {
      let verdict = null;
      try {
        verdict = inspect(req.method, req.url, body);
      } catch {}
      if (verdict && verdict.block) return fakeEmptyResponse(this);
      if (verdict && verdict.body !== undefined) body = verdict.body;
    }
    return nativeSend.call(this, body);
  };

  // Simule un « 204 No Content » pour qu'une requête bloquée passe pour réussie.
  function fakeEmptyResponse(xhr) {
    const define = (k, v) => Object.defineProperty(xhr, k, { value: v, configurable: true });
    define("readyState", 4);
    define("status", 204);
    define("statusText", "No Content");
    define("responseText", "");
    define("response", "");
    define("responseURL", xhr.__nova.url);
    xhr.getAllResponseHeaders = () => "";
    xhr.getResponseHeader = () => null;
    setTimeout(() => {
      for (const type of ["readystatechange", "load", "loadend"]) {
        const ev = new Event(type);
        xhr.dispatchEvent(ev);
      }
    }, 0);
  }

  // sendBeacon sert surtout à la télémétrie.
  if (navigator.sendBeacon) {
    const nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => {
      if (enabled("noTrack") && TRACKING_URL.test(String(url))) return true;
      return nativeBeacon(url, data);
    };
  }

  /* ------------------------------------------------------------------ */
  /* CSS                                                                 */
  /* ------------------------------------------------------------------ */

  // Feuilles « construites » : non soumises à la CSP de Discord, et
  // modifiables à chaud sans toucher au DOM.
  const sheet = new CSSStyleSheet();
  let sheetAttached = false;

  function attachSheet() {
    if (sheetAttached) return;
    try {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      sheetAttached = true;
    } catch {}
  }

  function applyCss() {
    const parts = [];
    for (const p of PLUGINS) {
      if (enabled(p.id) && PLUGIN_CSS[p.id]) parts.push(PLUGIN_CSS[p.id]);
    }
    const theme = THEMES[settings.theme];
    if (theme && theme.css) parts.push(theme.css);
    if (settings.customCss) parts.push(settings.customCss);
    try {
      sheet.replaceSync(parts.join("\n"));
    } catch {
      // CSS perso invalide : on applique le reste quand même.
      try {
        sheet.replaceSync(parts.slice(0, -1).join("\n"));
      } catch {}
    }
    attachSheet();
  }

  applyCss();
  if (!sheetAttached) document.addEventListener("DOMContentLoaded", applyCss, { once: true });

  /* ------------------------------------------------------------------ */
  /* Panneau de réglages                                                 */
  /* ------------------------------------------------------------------ */

  const PANEL_CSS = `
    :host { all: initial; }
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483646;
      background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center;
      font: 14px/1.4 "gg sans", "Segoe UI", system-ui, sans-serif; color: #dbdee1;
    }
    .panel {
      width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 64px);
      display: flex; flex-direction: column; background: #2b2d31; border-radius: 12px;
      box-shadow: 0 16px 48px rgba(0,0,0,.5); overflow: hidden;
    }
    header { display: flex; align-items: center; gap: 10px; padding: 16px 20px; border-bottom: 1px solid #1e1f22; }
    header h1 { flex: 1; margin: 0; font-size: 18px; color: #f2f3f5; }
    header small { color: #949ba4; font-size: 12px; }
    .close { background: none; border: 0; color: #b5bac1; font-size: 22px; cursor: pointer; padding: 0 4px; }
    .close:hover { color: #fff; }
    .body { overflow-y: auto; padding: 8px 20px 20px; }
    h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #949ba4; margin: 18px 0 8px; }
    .row { display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid #35373c; }
    .row:last-child { border-bottom: 0; }
    .row .text { flex: 1; }
    .row .name { color: #f2f3f5; font-weight: 600; }
    .row .desc { color: #b5bac1; font-size: 13px; margin-top: 2px; }
    .switch { position: relative; width: 40px; height: 24px; flex: none; margin-top: 2px; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; inset: 0; background: #4e5058; border-radius: 12px; cursor: pointer; }
    .slider::before { content: ""; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: transform .15s; }
    input:checked + .slider { background: #23a55a; }
    input:checked + .slider::before { transform: translateX(16px); }
    input:focus-visible + .slider { outline: 2px solid #00a8fc; outline-offset: 2px; }
    select, textarea {
      width: 100%; box-sizing: border-box; background: #1e1f22; color: #dbdee1;
      border: 1px solid #1e1f22; border-radius: 6px; padding: 8px 10px; font: inherit;
    }
    textarea { min-height: 140px; font-family: Consolas, "Cascadia Mono", monospace; font-size: 13px; resize: vertical; }
    select:focus, textarea:focus { outline: 2px solid #00a8fc; }
    .hint { color: #949ba4; font-size: 12px; margin-top: 6px; }
    .shortcuts .row { flex-wrap: wrap; align-items: center; }
    .shortcuts select { width: 100%; }
    .shortcuts .key { flex: 1; text-align: left; }
    .status { white-space: pre-line; color: #b5bac1; margin: 8px 0; }
    .sound-list { max-height: 220px; overflow-y: auto; }
    .sound-list .row { align-items: center; }
    .sound-list .text { overflow-wrap: anywhere; }
    footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; background: #232428; }
    button.btn { border: 0; border-radius: 4px; padding: 8px 16px; font: inherit; font-weight: 500; cursor: pointer; }
    .primary { background: #5865f2; color: #fff; }
    .primary:hover { background: #4752c4; }
    .secondary { background: #4e5058; color: #fff; }
    .secondary:hover { background: #6d6f78; }
    .toast {
      position: fixed; z-index: 2147483646; right: 20px; bottom: 20px; max-width: 340px;
      background: #111214; color: #dbdee1; border-radius: 8px; padding: 12px 14px;
      box-shadow: 0 8px 24px rgba(0,0,0,.4); font: 14px/1.4 "gg sans", "Segoe UI", system-ui, sans-serif;
    }
    .toast b { color: #fff; }
    kbd { background: #2b2d31; border-radius: 4px; padding: 1px 6px; font: inherit; font-size: 12px; }
  `;

  let host = null;

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) node.append(c);
    return node;
  }

  function makeHost() {
    const h = el("div", { id: "novacord-root" });
    const root = h.attachShadow({ mode: "open" });
    const style = new CSSStyleSheet();
    style.replaceSync(PANEL_CSS);
    root.adoptedStyleSheets = [style];
    document.body.append(h);
    return { h, root };
  }

  function closePanel() {
    if (recording) stopRecording();
    if (host) host.remove();
    host = null;
  }

  function openPanel() {
    if (host) return closePanel();
    if (!document.body) return;
    const { h, root } = makeHost();
    host = h;

    const shortcutEditor = el("div", { class: "shortcuts" });
    const soundboard = el("div");
    buildSoundboard(soundboard).catch(notifyError);
    buildShortcutEditor(shortcutEditor).catch(notifyError);
    const vencord = el("div", { class: "hint" }, window.Vencord
      ? "Vencord chargé. Le menu de qualité apparaît au démarrage d'un partage d'écran (1080p / 60 i/s par défaut)."
      : "Vencord n'a pas démarré : les fonctions de stream avancées sont indisponibles.");
    const vencordButton = el("button", { class: "btn secondary", onclick: () => {
      try {
        window.Vencord.Webpack.Common.SettingsRouter.openUserSettings("vencord_plugins");
        closePanel();
      } catch (error) { notifyError(error); }
    } }, "Ouvrir les plugins Vencord");

    const pluginRows = PLUGINS.map((p) => {
      const input = el("input", { type: "checkbox", "aria-label": p.name });
      input.checked = enabled(p.id);
      input.addEventListener("change", () => {
        settings.plugins[p.id] = input.checked;
        saveSettings();
        applyCss();
      });
      return el(
        "label",
        { class: "row" },
        el("div", { class: "text" }, el("div", { class: "name" }, p.name), el("div", { class: "desc" }, p.description)),
        el("span", { class: "switch" }, input, el("span", { class: "slider" })),
      );
    });

    const themeSelect = el("select", { "aria-label": "Thème" });
    for (const [id, t] of Object.entries(THEMES)) {
      const opt = el("option", { value: id }, t.name);
      if (id === settings.theme) opt.selected = true;
      themeSelect.append(opt);
    }
    themeSelect.addEventListener("change", () => {
      settings.theme = themeSelect.value;
      saveSettings();
      applyCss();
    });

    const cssInput = el("textarea", { spellcheck: "false", placeholder: "/* Ton CSS ici, appliqué en direct */" });
    cssInput.value = settings.customCss;
    let cssTimer = 0;
    cssInput.addEventListener("input", () => {
      clearTimeout(cssTimer);
      cssTimer = setTimeout(() => {
        settings.customCss = cssInput.value;
        saveSettings();
        applyCss();
      }, 300);
    });
    // Empêche Discord d'intercepter la frappe pendant l'édition.
    for (const type of ["keydown", "keyup", "keypress"]) {
      root.addEventListener(type, (e) => {
        if (e.key === "Escape") return;
        e.stopPropagation();
      });
    }

    const panel = el(
      "div",
      { class: "panel", role: "dialog", "aria-modal": "true", "aria-label": "Paramètres NovaCord" },
      el(
        "header",
        {},
        el("h1", {}, "NovaCord"),
        el("small", {}, HOTKEY_LABEL),
        el("button", { class: "close", "aria-label": "Fermer", onclick: closePanel }, "×"),
      ),
      el(
        "div",
        { class: "body" },
        el("h2", {}, "Streams et Vencord"),
        vencord,
        vencordButton,
        el("h2", {}, "Raccourcis personnalisés"),
        shortcutEditor,
        el("h2", {}, "Soundboard dans le micro"),
        soundboard,
        el("h2", {}, "Plugins"),
        ...pluginRows,
        el("h2", {}, "Thème"),
        themeSelect,
        el("h2", {}, "CSS personnalisé"),
        cssInput,
        el("div", { class: "hint" }, "Les plugins et le CSS s'appliquent tout de suite, sans redémarrer."),
      ),
      el(
        "footer",
        {},
        el("button", { class: "btn secondary", onclick: () => location.reload() }, "Recharger Discord"),
        el("button", { class: "btn primary", onclick: closePanel }, "Terminé"),
      ),
    );

    const backdrop = el("div", { class: "backdrop" }, panel);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) closePanel();
    });
    root.append(backdrop);
    const first = root.querySelector("input");
    if (first) first.focus();
  }

  async function buildShortcutEditor(container) {
    const snapshot = await invoke("get_shortcuts");
    let bindings = snapshot.bindings.map((b) => ({ ...b }));
    function updatePanelHotkey() {
      const label = container.getRootNode().querySelector("header small");
      if (label) label.textContent = bindings.find((b) => b.action === "panel")?.accelerator || "Icône près de l'horloge";
    }
    updatePanelHotkey();
    const sounds = await window.NovaCordAudio.list().catch(() => []);
    const actions = [
      ["panel", "Ouvrir les paramètres NovaCord"],
      ["TOGGLE_MUTE", "Activer / couper le micro"],
      ["TOGGLE_DEAFEN", "Activer / couper le casque"],
      ["TOGGLE_STREAMER_MODE", "Activer / couper le mode streamer"],
      ["TOGGLE_VOICE_MODE", "Changer le mode de détection vocale"],
      ["stopSounds", "Arrêter les sons"],
      ...sounds.map((sound) => ["sound:" + sound.id, "Jouer : " + sound.name]),
    ];
    const rows = el("div");
    const status = el("div", { class: "status", role: "status" }, snapshot.errors.join("\n"));
    function render() {
      rows.replaceChildren();
      for (const binding of bindings) {
        const select = el("select", { "aria-label": "Action du raccourci" });
        const options = actions.some(([id]) => id === binding.action) ? actions : [...actions, [binding.action, "Son supprimé — choisis une autre action"]];
        for (const [id, label] of options) {
          const option = el("option", { value: id }, label);
          option.selected = id === binding.action;
          select.append(option);
        }
        select.onchange = () => { binding.action = select.value; };
        const key = el("button", { class: "btn secondary key" }, binding.accelerator || "Enregistrer les touches");
        key.onclick = () => beginRecording(binding, key);
        rows.append(el("div", { class: "row" }, select, key, el("button", { class: "btn secondary", onclick: () => {
          if (recording) stopRecording();
          bindings = bindings.filter((b) => b !== binding);
          render();
        } }, "Supprimer")));
      }
    }
    render();
    container.append(
      el("div", { class: "hint" }, "Choisis l'action, clique sur les touches, puis enregistre. Fonctionne aussi en arrière-plan. Les conflits avec un autre logiciel sont signalés."),
      rows,
      el("button", { class: "btn secondary", onclick: () => { bindings.push({ action: "TOGGLE_MUTE", accelerator: "" }); render(); } }, "Ajouter un raccourci"),
      el("button", { class: "btn primary", onclick: async () => {
        try {
          await stopRecording();
          await invoke("set_shortcuts", { bindings });
          updatePanelHotkey();
          status.textContent = "Raccourcis enregistrés et actifs dans Windows.";
        } catch (error) { status.textContent = String(error.message || error); }
      } }, "Enregistrer les raccourcis"),
      status,
    );
  }

  async function buildSoundboard(container) {
    const audio = window.NovaCordAudio;
    if (!audio) { container.textContent = "Le mixeur audio n'a pas démarré."; return; }
    const status = el("div", { class: "status", role: "status" });
    const toggle = el("button", { class: "btn secondary", onclick: async () => {
      try {
        await audio.setEnabled(!audio.status().enabled);
        updateStatus();
      } catch (error) { status.textContent = String(error.message || error); }
    } });
    function updateStatus() {
      const state = audio.status();
      toggle.textContent = state.enabled ? "Désactiver la soundboard" : "Activer la soundboard";
      status.textContent = state.error || (state.active ? "Mixeur prêt sur ton micro." : state.enabled ? "Reconnecte le vocal pour brancher le mixeur sur ton micro." : "Active la soundboard avant de rejoindre le vocal.");
    }
    const list = el("div", { class: "sound-list" });
    async function refresh() {
      const sounds = await audio.list();
      list.replaceChildren();
      for (const sound of sounds) {
        const row = el("div", { class: "row" }, el("div", { class: "text" }, sound.name), el("button", {
          class: "btn secondary", onclick: () => audio.play(sound.id).catch(notifyError),
        }, "Jouer"));
        if (sound.local) row.append(el("button", { class: "btn secondary", onclick: async () => {
          try { await audio.remove(sound.id); await refresh(); } catch (error) { notifyError(error); }
        } }, "Supprimer"));
        list.append(row);
      }
      if (!sounds.length) list.textContent = "Importe un fichier audio, ou ouvre la soundboard Discord pour charger les sons de tes serveurs.";
    }
    const file = el("input", { type: "file", accept: "audio/*", "aria-label": "Importer un son" });
    file.onchange = async () => {
      try {
        if (!file.files[0]) return;
        await audio.import(file.files[0]);
        file.value = "";
        await refresh();
        status.textContent = "Son importé. Rouvre ce panneau pour lui attribuer un raccourci.";
      } catch (error) { status.textContent = String(error.message || error); }
    };
    const volume = el("input", { type: "range", min: "0", max: "100", value: "70", "aria-label": "Volume des sons" });
    volume.oninput = () => audio.setVolume(Number(volume.value) / 100);
    container.append(
      el("div", { class: "hint" }, "Les autres entendent les sons dans ta voix, sans effet soundboard natif. Ton micro doit être ouvert ; en appuyer-pour-parler, maintiens aussi ta touche. La suppression du bruit peut atténuer les sons."),
      toggle, status, file, el("div", {}, "Volume des sons", volume),
      el("button", { class: "btn secondary", onclick: () => refresh().catch(notifyError) }, "Actualiser les sons Discord"),
      el("button", { class: "btn secondary", onclick: audio.stopAll }, "Arrêter les sons"), list,
    );
    updateStatus();
    await refresh();
  }

  function welcome() {
    try {
      if (storage.getItem(SEEN_KEY)) return;
      storage.setItem(SEEN_KEY, "1");
    } catch {
      return;
    }
    const { h, root } = makeHost();
    const kbd = el("kbd", {}, HOTKEY_LABEL);
    root.append(
      el(
        "div",
        { class: "toast", role: "status" },
        el("b", {}, "NovaCord est prêt. "),
        "Ouvre les plugins et thèmes avec ",
        kbd,
        " ou depuis l'icône de la zone de notification.",
      ),
    );
    setTimeout(() => h.remove(), 9000);
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (recording) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === "Escape") {
          recording.button.textContent = recording.binding.accelerator || "Enregistrer les touches";
          stopRecording();
        } else if (!e.repeat && !["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
          const parts = [];
          if (e.ctrlKey) parts.push("Ctrl");
          if (e.altKey) parts.push("Alt");
          if (e.shiftKey) parts.push("Shift");
          if (e.metaKey) parts.push("Super");
          parts.push(e.code);
          captureShortcut(parts.join("+"));
        }
      } else if (e.key === "Escape" && host) {
        e.stopPropagation();
        closePanel();
      }
    },
    true,
  );

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(welcome, 4000), { once: true });
  } else {
    setTimeout(welcome, 4000);
  }

  Object.defineProperty(window, "NovaCord", {
    value: Object.freeze({ openPanel, runShortcut, captureShortcut, version: "0.2.0" }),
    configurable: false,
    writable: false,
  });
})();
