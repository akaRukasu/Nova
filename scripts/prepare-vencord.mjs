import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const upstream = resolve(process.argv[2] || ".vencord");
const revision = "8d64c8be7e68616f8f116a6fff9480051aa2a0c5";
if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" }).trim() !== revision) {
  throw new Error("Version Vencord inattendue : utiliser le commit " + revision);
}
writeFileSync(resolve(upstream, "browser/NovaCordNative.ts"), `
import "./VencordNativeStub";
VencordNative.native.getRendererCss = async () => (window as any).__NOVACORD_VENCORD_CSS;
`);
const entry = resolve(upstream, "browser/Vencord.ts");
const source = readFileSync(entry, "utf8");
if (!source.includes('import "./NovaCordNative"')) {
  writeFileSync(entry, source.replace('import "./VencordNativeStub";', 'import "./NovaCordNative";'));
}
execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["buildWeb", "--standalone", "--skip-extension", "--dev"], {
  cwd: upstream, stdio: "inherit", shell: process.platform === "win32",
});
const css = readFileSync(resolve(upstream, "dist/browser.css"), "utf8");
const js = readFileSync(resolve(upstream, "dist/browser.js"), "utf8");
const bootstrap = readFileSync(new URL("../mod/vencord-bootstrap.js", import.meta.url), "utf8");
mkdirSync(new URL("../mod/", import.meta.url), { recursive: true });
writeFileSync(new URL("../mod/vencord.bundle.js", import.meta.url), `(() => {
if (window.top !== window || location.hostname !== "discord.com") return;
window.__NOVACORD_VENCORD_CSS = ${JSON.stringify(css)};
${bootstrap}
${js}
window.Vencord = Vencord;
})();`);
writeFileSync(new URL("../mod/VENCORD-LICENSE.txt", import.meta.url), readFileSync(resolve(upstream, "LICENSE")));
writeFileSync(new URL("../mod/VENCORD-NOTICES.txt", import.meta.url), readFileSync(resolve(upstream, "dist/browser.js.LEGAL.txt")));
console.log("Vencord embarqué : " + revision);
