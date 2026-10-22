import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

function commit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return "local"; }
}

// Strict Content Security Policy. GitHub Pages cannot send headers, so it rides in a <meta> tag.
// Only added to production builds: the dev server needs inline scripts and a websocket for hot reload.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

function securityMeta(): Plugin {
  return {
    name: "nakwad-security-meta",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      // right after <meta charset>, ahead of every script and stylesheet, so the policy covers them all
      handler: (html) => {
        const tags = `\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <meta name="referrer" content="no-referrer" />`;
        const marker = '<meta charset="utf-8" />';
        if (!html.includes(marker)) throw new Error("index.html must start its <head> with " + marker);
        return html.replace(marker, marker + tags);
      },
    },
  };
}

export default defineConfig({
  // the app is served from https://zetsubo07.github.io/nakwad/
  base: "/nakwad/",
  define: {
    __APP_VERSION__: JSON.stringify(`${pkg.version}+${commit()}`),
  },
  build: {
    target: "es2022",
    // keep every asset a real file so the CSP never needs data: for scripts, styles or fonts
    assetsInlineLimit: 0,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        // brush lab (milestone M4): try the drawing engine on the tablet before the full app exists
        lab: fileURLToPath(new URL("./lab.html", import.meta.url)),
      },
    },
  },
  plugins: [
    securityMeta(),
    // installed now, switched on in milestone M7 (offline, install, update prompt)
    VitePWA({ disable: true, injectRegister: false }),
  ],
});
