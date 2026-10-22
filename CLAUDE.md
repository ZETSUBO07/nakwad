# nakwad (นักวาดมือฉมัง)

A personal drawing PWA for a Xiaomi Pad 6S Pro with the Xiaomi Focus Pen, served from GitHub Pages at `/nakwad/`.
The spec and the release 1 plan live as Claude Docs in the claude.ai project "นักวาดมือฉมัง".

## Working agreement
- The owner wants to discuss before any work starts: ask first, build after they answer.
- One milestone (M0–M8 in the release 1 plan) at a time, each as a pull request that must pass CI.

## Rules for code
- All user-facing text lives in `src/i18n/th.ts` and is read with `t("key")`. Never write Thai in other source files; ESLint fails the build if you do.
- `src/core/` must not touch the DOM or Canvas, so it stays testable with Vitest alone.
- Keep the strict CSP working: no inline scripts or styles, no external hosts. Fonts are self-hosted via `@fontsource/*`.
- Do not use `element.setAttribute("style", …)` (blocked by the CSP); set `element.style.x` instead.
- Pin dependency versions exactly; GitHub Actions are pinned to commit SHAs.

## Commands
- `npm run dev` – dev server
- `npm run check` – lint, typecheck, unit tests, build, end-to-end tests (what CI runs)
- End-to-end tests locally with a different Chromium: `PW_CHROMIUM=/path/to/chrome npm run e2e`
