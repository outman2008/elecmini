# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Delta (incremental) updates** (`pack/delta.js`, inspired by Ubuntu/Debian debdelta): the server keeps multiple historical versions and auto-generates `latest-old.diff` for every old version (`node pack/delta.js --batch --versions dist/versions --out dist/deltas`). Clients select by their own version — v1 picks `3-1.diff`, v2 picks `3-2.diff` — and rebuild from local files instead of re-downloading the full package. Pure-Node block-level diff (`COPY`/`ADD` instructions), zero dependencies; unchanged files are excluded. `autoUpdater` now prefers a matching delta, falls back to full download on any failure (bad hash, missing local dir, network error), and **still runs `verifyRelease` (Ed25519 + files[] sha256)** on the rebuilt staging — deltas never bypass signature verification. Added `delta-selected` / `delta-fallback` events and `downloadMode` field; `docs/incremental-update.md` documents the design and failure matrix. Added `pack/delta.js --self-test` (12 assertions) to CI and 2 `autoUpdater` delta/fallback unit tests (modules 28/28).
- **Deltas generated automatically at pack time**: `pack/build.js` now archives each build as a version snapshot (`dist/versions/<sku>-<target>/<version>/`), generates `latest←old` diffs into `dist/deltas/`, and embeds the `deltas` index into `dist/update.json` — no separate `delta.js --batch` step needed. Version source is `--version > package.json > config.json` (the stale `0.2.0` in config is no longer authoritative); `update.json` is rebuilt from the latest output on every pack so `files[]`/`version` never go stale. First pack with a single version degrades gracefully to an empty index (clients fall back to full); `--no-delta` opts out entirely. `delta.js --self-test` extended to 16 assertions covering the pack→archive→diff→update.json chain.

### Fixed

- **Tray menu clicks (OpenChamber migration)**: the host emits `tray:menu` with `commandId`, but the JS shim only subscribed to `tray:click`, so tray `Menu.buildFromTemplate` `click` callbacks (e.g. OpenChamber's "Open"/"Quit") never fired. `Tray.setContextMenu` now retains template items and falls back to `label` as the command id when no explicit `id` is set (matching host-side behavior); `bindTrayEvents` dispatches `tray:menu` back to the matching item's `click`. Regression test added in `runtime/modules/modules.test.js` (26/26).
- **Tray icon dataURL decoding**: `TrayManager::set_image` fed raw PNG bytes to `Icon::from_rgba`, producing a corrupted icon while silently succeeding whenever the byte count happened to match a guessed size. It now decodes PNG/ICO via `image 0.25` before RGBA conversion. Added Rust unit tests for a generated 16x16 PNG data URL and malformed inputs (6/6 total).
- Verified on Windows 11 / WebView2 133: gate L0, diff contract 42/42, P1/P2 E2E, S4 7/7, DevTools 4/4, security suite 22/22, and an OpenChamber `slim-win32-x64` rebuild (17664 files, SHA256 all match). See `docs/acceptance/Windows-v1.1.0-适配验证.md`.

## [1.1.0] - 2026-11-26

Feature release: cross-platform DevTools and the five deep-integration gaps that make OpenChamber migration viable on ElecMini.

### Changed

- **Installer-size-first positioning**: README (both languages), `llms.txt` and promo drafts now lead with the size win — Electron **~274MB** vs ElecMini Slim **~84MB**, about **1/3 the size (~3x smaller)** — and drop the previous PSS ≈107% "no memory gain" caveat from the top-level pitch. The bundled-engine comparison (274MB → 2.3MB, ~118x) is retained with its methodology note; no benchmark numbers were changed.
- **Logo redesigned** (`assets/logo.svg`): the previous dark badge with a full electron-style atom is replaced by a more abstract mark — one open, lightweight orbit (candy gradient rose → violet → cyan), a warm amber core standing for the preserved JS API contract, and three small platform dots (WebView2 / WKWebView / WebKitGTK) on a clean triangular orbit. The badge background was dropped in favour of a transparent canvas, so the mark reads equally well on GitHub's light and dark themes. Same file path, no reference changes needed.

### Added

- **Restored real-project migration examples** from git history after the public-release cleanup: `migrate/full-app/` (electron-api-demos full-UI adapter + 6-assertion DOM verifier), `migrate/probes/` (caprine / electron-react-boilerplate / electron-api-demos API probes), and `migrate/REPORT-*.md` (real-project findings). Added `migrate/full-app/README.md` with reproduction steps, made `verify.js` accept `--src`/`--out`, and gitignored the third-party source and adapted output. Revalidated end-to-end: caprine probe 45/45, full-UI verify 6/6.
- **Discoverability / AI assets**: `assets/social-preview.png` (1280x640 share image, set as the GitHub Social preview), `llms.txt` (machine-readable project summary + canonical doc links for LLM retrieval), and `AGENTS.md` (AI coding-agent entry: layout, commands, encoding conventions). All three added to the npm `files` whitelist.
- **Cross-platform DevTools**: `openDevTools()` / `closeDevTools()` / `isDevToolsOpen()` now work on all three platforms. Previously every non-Windows platform was hard-coded to error even though wry provides native Web Inspector support. Enabled wry's `devtools` feature so release builds include it; added `contract/devtools-check.js` (5 assertions, wired into CI).
- **OpenChamber migration — five deep-integration gaps closed**: (1) `Notification` is now exported with a cross-platform host backend (`notification.rs`: notify-send / osascript / PowerShell) and `notification:show|close|isSupported` RPC; (2) `Tray` upgraded from hard-coded degrade to a real implementation via `tray-icon 0.24.2` + `muda 0.19.3` (matched to tao 0.34 / gtk 0.18), with `tray:*` RPCs and click/menu event pushback; (3) `autoUpdater` exported as an electron-updater-compatible EventEmitter, mapped onto `pack/update.js` (Ed25519 + rollback) — event sequence checking/available/progress/downloaded/error; (4) **multi-WebView / `webviewTag`**: host `webview:create|loadURL|getURL|setBounds|executeJavaScript|destroy` RPCs using wry `build_as_child`, plus a `<webview>` custom element injected from preload and a Node bridge (`webview-bridge.js`) — `loadURL`/`getURL`/`executeJavaScript`/`did-navigate`/`dom-ready` align, while `clearHistory`/`isCrashed` and DOM-layout-following are honestly marked degraded; (5) SSH needs no ElecMini change — the pure-Node `ssh-manager.mjs` runs in the sidecar as-is. Added `contract/webview-check.js` (21 assertions, wired into CI) and `migrate/OPENCHAMBER.md` documenting the boundaries. See `docs/unsupported-apis.md` for the honest limitation table.

### Changed

- **Repository metadata**: description front-loads the `Electron alternative` keyword; topics expanded 12 → 16 (added `javascript`, `cross-platform`, `lightweight`, `gui`); homepage now points to the npm package instead of self-referencing the README.
- **README section headings** (both languages) rewritten as question-style for human and AI extraction ("What is ElecMini?", "How does it compare with Electron/Tauri?", "Which API tiers exist?", "What are the known limits?"). Content unchanged; no anchor links broken.
- **Honest capability reporting**: `s4:capabilities` now distinguishes CDP (Windows-only, Chromium-private protocol) from the DevTools inspector window (all platforms). Non-Windows reports `devtools: true` with a platform backend (`webview2` / `wkwebview-private-api` / `webkit-web-inspector`) and a `cdpAlternative` hint (Safari Web Inspector / `WEBKIT_INSPECTOR_SERVER`). README (both languages) and promo drafts updated to match.

## [1.0.2] - 2026-11-24

Quality-gate and Codec regression hardening. No runtime behavior changes.

### Added

- **Prettier ratchet gate** (`ci/prettier-ratchet.js` + `ci/prettier-baseline.json`): an incremental formatting gate that exempts historical files by content hash but blocks any newly added or edited file that is still non-compliant. Once a file becomes compliant it is removed from the baseline — the rule only tightens. Wired into `ci/check.sh` and exposed as `npm run format:ratchet` / `format:baseline`. Meets the "do not block legacy code" requirement while preventing new drift.
- **6 new Codec cross-realm consistency cases** (`runtime/codec-consistency.test.js`, 4 → 10): label-set alignment (incl. the documented Buffer→TypedArray browser downgrade), nested containers, empty containers, multi-constructor TypedArrays, BigInt extremes + Unicode, and DataView downgrade. Locks the two-end wire contract so a label change on either side fails CI immediately.

### Changed

- `package.json` `files` whitelist now carries the ratchet script and baseline so the published `ci/check.sh` does not reference a missing file.
- `ci/README.md` documents the ratchet gate and its commands.
- **Visual assets for the project homepage**: `assets/logo.svg` (electron-style open orbits + three platform satellites), `assets/size-comparison.svg` (measured Linux x64 engine-size comparison, ~118x), and `assets/demo.gif` (real autotest terminal output: gate → host ready → IPC round-trip). Wired into both READMEs; `assets/` added to the npm `files` whitelist.
- **Promotion drafts** under `docs/promo/`: `show-hn.md` (English Show HN) and `juejin-article.md` (Chinese Juejin/V2EX). Drafts only — not auto-posted, and excluded from the npm package.

## [1.0.1] - 2026-11-24

Packaging and usability fixes for the first public release.

### Added

- **CLI entry point** `elecmini` (`bin/elecmini.js`) with `run` / `assess` / `probe` / `audit` / `check` subcommands, plus `main` field pointing at the shim. `npm install elecmini` now yields a usable command instead of a package with no entry.
- **`examples/minimal/`**: a runnable 4-file example (one window + one IPC round-trip), verified end-to-end on WebKitGTK.
- **Per-directory READMEs**: `runtime/`, `host/`, `pack/`, `contract/`, `compat/`, `shim/`, `tests/`, `ci/`.

### Changed

- `Cargo.toml` workspace version synced to `1.0.0` (was `0.1.0`, out of step with npm).
- Test fixtures renamed to a consistent scheme: `tests/p1|p2|s4|win|baseline` → package names `elecmini-fixture-*`, version `1.0.0`, all `private`.
- `contract/run.js` protective timeout raised from 12s to 60s so dual cold-start does not truncate window-dependent cases.
- README quick start now leads with the CLI and the minimal example; API tier table clarifies that 984 is the full member count and 525 is the graded core subset.
- Platform table documents that 17 of the 42 differential cases require a display environment.

### Removed

- Empty `launcher/` directory (and its stale `files` entry in `package.json`).

### Fixed

- `Cargo.lock` is now tracked (this is an application, not a library) for reproducible builds.

## [1.0.0] - 2026-11-24

First public release. ElecMini is a compatibility layer that keeps the Electron JS API
contract while rendering through the system WebView (WebView2 / WKWebView / WebKitGTK)
instead of bundling Chromium.

### Added

- **System WebView runtime**: Rust host (tao + wry) plus Node sidecar communicating over JSONL JSON-RPC; `require('electron')` is redirected to the ElecMini shim.
- **API contract compatibility**: 100% surface coverage of Electron 45.x `electron.d.ts` core modules (20 modules / 984 members), classified into native (113) / mirror (327) / degraded (85) tiers, generated by `migrate/api-surface/audit.js`.
- **Renderer bridge**: preload runtime injection with restricted `require('electron')`, `contextBridge` and `ipcRenderer`; contract-fill layer for missing members.
- **Startup gate & degradation**: system WebView version classification (L0/L1/L2/L3), fail-safe guidance instead of a blank screen.
- **Security hardening**: host-side navigation origin anchoring, IPC source validation, optional `ELECMINI_STRICT_NAV=1` strict cross-origin navigation blocking.
- **Migration toolchain**: static AST scan (`migrate/assess.js`), runtime probe generation (`migrate/gen-probe.js`), differential contract tests (`contract/run.js`).
- **Packaging & distribution**: Slim / Full SKUs, code signing, auto-update with signature verification and rollback, canary bucketing, telemetry aggregation.
- **Platform support**: full E2E on Linux (WebKitGTK) and Windows (WebView2, incl. S4 CDP/DevTools capabilities and security suite); build + unit tests on macOS.
- **Documentation**: bilingual README (中文 / English), migration guide, unsupported API list, contributing and security policies.

### Changed

- Migrated sync API stubs to return type-correct safe defaults synchronously (`showMessageBoxSync` → `defaultId`, `sendSync` → `undefined`), avoiding silent truthiness bugs.
- Corrected `executeJavaScript` to return raw values (no `{ok, value}` envelope), matching Electron semantics.
- Aligned `nativeImage` factory names with the official `createFromDataURL` / `createFromPath` contract.

### Removed

- Development-phase artifacts (P0–P4 docs, design roadmap, internal acceptance reports and validation reports) from the public distribution.
- Internal SSH credential and sandbox-specific configuration documentation.

### Known limitations

- No Electron-grade `contextIsolation`: preload and page share a realm; do not treat it as a security sandbox.
- Sync APIs are degraded stubs; Chromium extensions and `@electron/remote` are unsupported.
- Memory is not reduced (PSS ≈ 107% of Electron); the Go/No-Go L0 ≥95% conclusion requires production telemetry.
- CDP / DevTools are available only on Windows WebView2.

[1.0.0]: https://github.com/outman2008/elecmini/releases/tag/v1.0.0
