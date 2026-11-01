const { createRequire } = require("node:module");
const { readFileSync, existsSync } = require("node:fs");
const { resolve } = require("node:path");
const assert = require("node:assert/strict");
const upstream = createRequire(resolve(".vencord/package.json"));
const puppeteer = upstream("puppeteer-core");

(async () => {
  const executablePath = [process.env.EDGE_BIN, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((path) => path && existsSync(path));
  assert.ok(executablePath, "Navigateur Edge de test introuvable");
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.isNavigationRequest()) request.respond({ status: 200, contentType: "text/html", body: "<!doctype html><html><head></head><body><main>Discord test</main></body></html>" });
      else request.abort();
    });
    await page.evaluateOnNewDocument(() => {
      let bindings = [{ action: "panel", accelerator: "Ctrl+Alt+KeyN" }];
      window.__TAURI__ = { core: { invoke: async (command, args) => {
        if (command === "get_shortcuts") return { bindings, errors: [] };
        if (command === "set_shortcuts") {
          const keys = args.bindings.map((binding) => binding.accelerator);
          if (new Set(keys).size !== keys.length) throw new Error("Deux raccourcis utilisent les mêmes touches.");
          bindings = structuredClone(args.bindings);
          return { bindings, errors: [] };
        }
      } } };
    });
    for (const path of ["mod/vencord.bundle.js", "mod/soundboard.js", "mod/novacord.js"]) {
      await page.evaluateOnNewDocument(readFileSync(path, "utf8"));
    }
    await page.goto("https://discord.com/app");
    await page.evaluate(() => window.NovaCord.openPanel());
    await page.waitForFunction(() => document.querySelector("#novacord-root")?.shadowRoot.querySelector(".shortcuts select"));
    assert.equal(await page.evaluate(() => !!window.Vencord.Settings.plugins.FakeNitro.enabled), true);
    assert.equal(await page.evaluate(() => window.NovaCord.version), "0.2.0");
    const clickText = (text) => page.evaluate((text) => {
      const root = document.querySelector("#novacord-root").shadowRoot;
      const button = [...root.querySelectorAll("button")].find((button) => button.textContent === text);
      if (!button) throw new Error("Bouton absent : " + text);
      button.click();
    }, text);
    await clickText("Ajouter un raccourci");
    await clickText("Enregistrer les touches");
    await page.waitForFunction(() => document.querySelector("#novacord-root").shadowRoot.textContent.includes("Appuie sur les touches"));
    await page.keyboard.down("Control");
    await page.keyboard.down("Alt");
    await page.keyboard.press("KeyL");
    await page.keyboard.up("Alt");
    await page.keyboard.up("Control");
    await clickText("Enregistrer les raccourcis");
    await page.waitForFunction(() => document.querySelector("#novacord-root").shadowRoot.textContent.includes("enregistrés et actifs"));
    const saved = await page.evaluate(() => window.__TAURI__.core.invoke("get_shortcuts"));
    assert.equal(saved.bindings[1].accelerator, "Ctrl+Alt+KeyL");
    await page.evaluate(() => window.NovaCord.openPanel());
    await page.evaluate(() => window.NovaCord.openPanel());
    await page.waitForFunction(() => document.querySelector("#novacord-root").shadowRoot.textContent.includes("Ctrl+Alt+KeyL"));
    await clickText("Activer la soundboard");
    await page.waitForFunction(() => window.NovaCordAudio.status().enabled);
    const audio = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const active = window.NovaCordAudio.status().active;
      const track = stream.getAudioTracks()[0];
      const settings = track.getSettings();
      track.stop();
      return { active, device: !!settings.deviceId, stopped: !window.NovaCordAudio.status().active };
    });
    assert.deepEqual(audio, { active: true, device: true, stopped: true });
    assert.deepEqual(errors, [], "Erreurs au chargement de l'application");
    console.log("Edge : chargement Vencord, création/sauvegarde des raccourcis et capture micro validés.");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
