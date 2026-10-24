import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { th } from "./src/i18n/th";

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
    // M7: install, offline, and new versions that take over the next time the app opens
    VitePWA({
      injectRegister: false, // src/ui/offline.ts registers it, and decides when a new version takes over
      registerType: "prompt",
      includeManifestIcons: false, // the icons are in globPatterns already
      manifest: {
        id: "/nakwad/",
        name: th.appName,
        short_name: th.appName,
        description: th.appDescription,
        lang: "th",
        dir: "ltr",
        start_url: "/nakwad/",
        scope: "/nakwad/",
        display: "fullscreen",
        display_override: ["fullscreen", "standalone"],
        orientation: "any",
        background_color: "#121318",
        theme_color: "#121318",
        categories: ["graphics", "art", "productivity"],
        // backup files can be sent to the app with the Android share menu (public/share-target.js keeps them)
        share_target: {
          action: "/nakwad/share-target",
          method: "POST",
          enctype: "multipart/form-data",
          params: { files: [{ name: "file", accept: [".sketchbook", "application/octet-stream", "application/zip", "application/x-zip-compressed"] }] },
        },
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "icons/icon-monochrome-96.png", sizes: "96x96", type: "image/png", purpose: "monochrome" },
          { src: "icons/icon-monochrome-512.png", sizes: "512x512", type: "image/png", purpose: "monochrome" },
        ],
      },
      workbox: {
        // every app file, plus the fonts of the interface; the text tool's fonts are kept the first time they are used
        globPatterns: ["**/*.{html,js,css,png,svg,webmanifest}", "assets/{mali,anuphan,sriracha,noto-sans-thai}-*.woff2"],
        globIgnores: ["**/*.map"],
        navigateFallback: "/nakwad/index.html",
        navigateFallbackDenylist: [/\/lab\.html$/],
        cleanupOutdatedCaches: true,
        importScripts: ["share-target.js"],
        skipWaiting: false,
        clientsClaim: false,
        runtimeCaching: [{
          urlPattern: ({ url }) => url.pathname.startsWith("/nakwad/assets/") && /\.(woff2?|ttf|otf)$/.test(url.pathname),
          handler: "CacheFirst",
          options: { cacheName: "nakwad-fonts", expiration: { maxEntries: 120 } },
        }],
      },
    }),
  ],
});
