const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync } = require("node:fs");
const { createServer } = require("node:net");
const { tmpdir } = require("node:os");
const { resolve } = require("node:path");
const { createRequire } = require("node:module");
const { setTimeout: delay } = require("node:timers/promises");
const puppeteer = createRequire(resolve(".vencord/package.json"))("puppeteer-core");

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function checkStandardWindow() {
  const executable = resolve(process.argv[2]);
  const port = await freePort();
  const profile = mkdtempSync(resolve(tmpdir(), "voxcord-standard-"));
  const child = spawn(executable, [], { windowsHide: true, env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  } });
  let childError;
  child.once("error", (error) => { childError = error; });
  let browser;
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 55000;
    while (Date.now() < deadline) {
      if (childError) throw childError;
      if (child.exitCode !== null) throw new Error(`Voxcord closed early: ${child.exitCode}`);
      if (!browser) {
        try {
          const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
          const { webSocketDebuggerUrl } = await response.json();
          if (webSocketDebuggerUrl) browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl });
        } catch {
          // WebView2 has not started listening yet.
        }
      }
      const pages = browser ? await browser.pages() : [];
      const page = pages.find((candidate) => candidate.url().startsWith("https://discord.com/"));
      if (page && await page.$('input[type="password"]')) {
        const state = await page.evaluate(async () => {
          const mods = ["Vencord", "NovaCord", "NovaCordAudio", "NovaCordMedia", "NovaCordRemote"];
          let nativeShortcutAccess = false;
          if (window.__TAURI__?.core?.invoke) {
            try {
              await window.__TAURI__.core.invoke("get_shortcuts");
              nativeShortcutAccess = true;
            } catch {
              // The standard window has no remote capability for this command.
            }
          }
          return { mods: mods.filter((name) => name in window), nativeShortcutAccess };
        });
        assert.deepEqual(state, { mods: [], nativeShortcutAccess: false });
        console.log("Discord's own sign-in page rendered without extensions or access to Voxcord shortcut commands.");
        return;
      }
      await delay(300);
    }
    throw new Error("The embedded Discord sign-in page did not render within 55 seconds.");
  } finally {
    await browser?.disconnect();
    child.kill();
  }
}

checkStandardWindow().catch((error) => { console.error(error); process.exitCode = 1; });
