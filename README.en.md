<div align="center">

<img src="./assets/logo.svg" alt="ElecMini logo" width="120" />

# ElecMini

**The Electron JS API contract, without Chromium — rendered by the system WebView.**

[![CI](https://github.com/outman2008/elecmini/actions/workflows/ci.yml/badge.svg)](https://github.com/outman2008/elecmini/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/elecmini.svg)](https://www.npmjs.com/package/elecmini)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#platform-support)

[English](./README.en.md) · [中文](./README.md)

</div>

---

## What is ElecMini and what problem does it solve?

ElecMini is **not** a fork of Electron. It is a **compatibility layer**: your business code keeps calling `require('electron')`, while underneath a **Rust host (tao windows + wry WebView) plus a Node sidecar** takes over, rendering through the **system WebView** (WebView2 / WKWebView / WebKitGTK) instead of shipping Chromium with your app.

It solves a specific problem: you want a **smaller installer, faster cold start, and reuse of the system renderer**, without rewriting the Electron API calls in an existing app. ElecMini offers a low-friction migration path.

> ⚠️ **Read this before deciding**: ElecMini is about shrinking the bundle and startup cost, not reducing memory. Measured PSS is about **107% of Electron** — the system WebView engine is still a fixed cost, and the ~240MB "engine tax" cannot be removed. If your primary goal is "dramatically lower memory", this project is not the answer.

## Features

- **API contract compatibility**: audited against Electron's official `electron.d.ts` (45.x), with **100% surface coverage** of the core 20 modules / 984 members, strictly classified by semantics (native / mirror / degraded).
- **System WebView rendering**: WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux — no bundled Chromium.
- **Node sidecar process model**: Node runs the business main process, Rust runs windows and WebView, communicating over JSONL JSON-RPC.
- **Migration toolchain**: static AST scan → Go/No-Go prediction → auto-generated runtime probes → differential contract tests, turning "can we migrate" into a repeatable process.
- **Startup gate & degradation**: classify by system WebView version (L0/L1/L2/L3), fail with clear guidance instead of a blank screen when capabilities are missing.
- **Packaging & distribution**: Slim / Full SKUs, code signing, auto-update (with signature verification and rollback), canary bucketing.
- **Security hardening**: host-side navigation origin anchoring + IPC source validation, with optional `ELECMINI_STRICT_NAV=1` strict cross-origin blocking.

## How does ElecMini compare with Electron and Tauri?

| Dimension | Electron | Tauri | ElecMini |
|---|---|---|---|
| Rendering engine | Bundled Chromium | System WebView | System WebView |
| Main process language | Node.js | Rust | Node.js (sidecar) |
| Installer size | Large (bundles Chromium) | Small | Small |
| Memory (PSS) | Baseline | Lower | ≈ 107% of Electron (no memory gain) |
| Electron JS API | Native | None, must rewrite | Compatibility layer (100% surface, tiered semantics) |
| Migrating an existing Electron app | — | Rewrite main process | Low friction (reuse `require('electron')`) |

In one line: **Tauri targets new apps (Rust main process), ElecMini targets low-cost migration of existing Electron apps.**

![Engine size comparison (measured, Linux x64)](./assets/size-comparison.svg)

> The chart compares **bundled engine size**, not total installer size: ElecMini relies on the OS-provided WebView (a shared dependency), while Electron ships the entire Chromium with the app. Measured on Linux x64; see the SVG for the exact methodology.

## Architecture

```
Target app (main.js / preload.js)
        │  require('electron')  → shim (runtime/electron.js)
        ▼
   Node sidecar (runtime/launcher.js) ──JSONL JSON-RPC──▶ Rust host (host/src/main.rs)
        │                                                      │ tao window + wry WebView
        │                                                      ▼
        └──────────────  local static server http://127.0.0.1:port  ──▶ system WebView renders the page
```

- **Renderer preload**: `runtime/preload-runtime.js` is injected via initialization script, providing a restricted `require('electron')` / `contextBridge` / `ipcRenderer`.
- **Contract fill layer**: `runtime/contract-fill.js` ensures every member declared in the official `electron.d.ts` exists, tagged as native / mirror / degraded.
- **Migration tools**: `migrate/assess.js` statically scans the target project → Go/No-Go prediction; `migrate/gen-probe.js` generates runtime probes.

## Quick start

Prerequisites: Node 22, Rust stable; Linux needs `libwebkit2gtk-4.1-dev` (macOS / Windows use the built-in system WebView).

```bash
# 1) Clone and build the Rust host (once)
git clone https://github.com/outman2008/elecmini.git && cd elecmini
cargo build --release -p elecmini-host --bin elecmini-host

# 2) Run the minimal example (one window + one IPC round-trip)
npx elecmini run examples/minimal
# or directly:
node runtime/launcher.js examples/minimal

# 3) Migration assessment: static-scan your existing Electron app
npx elecmini assess --project <yourAppDir>

# 4) Checks
npx elecmini check --quick     # quick: skip build / E2E
npx elecmini check             # full (needs xvfb-run on Linux)
```

> After install, the CLI also exposes `elecmini run / assess / probe / audit / check`; see `elecmini --help`.
> Minimal example: [`examples/minimal/`](./examples/minimal/).

![ElecMini demo: gate → host ready → IPC round-trip (real autotest output)](./assets/demo.gif)

> The demo is real autotest terminal output (gate L0 → host ready → `ipcRenderer.invoke('ping')` → `PING_RESULT` → typed round-trip → quit).
> The headless CI environment cannot capture the WebKitGTK window surface, so the demo uses measured terminal output; every line comes from an actual run.

## Which API support tiers exist?

Surface coverage ≠ semantic completeness. Electron 45.4.1 official type definitions contain **984 members** (50 exports). ElecMini grades the members of the **core 20 modules** semantically — 525 items in total:

| Tier | Count | Meaning |
|---|---|---|
| **native** | 113 | Real native implementation, behavior matches Electron |
| **mirror** | 327 | State mirror / lightweight wrapper, highly usable |
| **degraded** | 85 | Stub returning a type-correct safe default, or a platform-specific boundary |

> Note: 984 is the **full** official member count (including non-core modules); 525 is the **graded** subset of the core set.
> Surface coverage of the core 20 modules is 100%; remaining exports outside the core set are not guaranteed.

Tiers are generated live by `node migrate/api-surface/audit.js`; the full unsupported list is in [`docs/unsupported-apis.md`](./docs/unsupported-apis.md). Always run `node migrate/assess.js --project <appDir>` before migrating.

## Platform support

| Platform | WebView | Build | E2E verification |
|---|---|---|---|
| Windows | WebView2 | ✅ | ✅ Full native suite (security 22/22, differential contract 42/42) |
| macOS | WKWebView | ✅ | CI build + unit tests; runtime needs a macOS machine |
| Linux | WebKitGTK | ✅ | ✅ Full (differential 42/42, E2E; needs `xvfb-run`) |

> 17 of the 42 differential cases depend on a real window / screen / session and **must run in a display environment**
> (Linux: `xvfb-run`; Windows: real desktop). Without a display they are not written, so only 25 cases are compared.

## What are the known limits and boundaries?

- **No Electron-grade contextIsolation**: preload and page share the same realm; isolation relies on host-side origin anchoring + IPC source validation. **Do not** treat it as a security sandbox.
- **Sync API degradation**: `sendSync` returns `undefined`, `showMessageBoxSync` returns `defaultId`, etc. — type-correct but not real interaction results; rewrite to async.
- **Architecturally unfixable**: Chromium extension system and `@electron/remote` are explicitly unsupported.
- **CDP / DevTools** work on Windows WebView2; no equivalent on macOS / Linux.
- **The L0 ≥95% Go/No-Go conclusion** still needs production telemetry samples (current local samples are far below the statistical minimum of 385).

## Documentation index

| Topic | Document |
|---|---|
| Minimal example | [`examples/minimal/`](./examples/minimal/) |
| Migration assessment guide | [`migrate/README.md`](./migrate/README.md) |
| Unsupported API list | [`docs/unsupported-apis.md`](./docs/unsupported-apis.md) |
| API surface audit tool | [`migrate/api-surface/audit.js`](./migrate/api-surface/audit.js) |
| Runtime (Node sidecar) | [`runtime/README.md`](./runtime/README.md) |
| Native host (Rust) | [`host/README.md`](./host/README.md) |
| Differential contract tests | [`contract/README.md`](./contract/README.md) |
| Packaging / signing / update | [`pack/README.md`](./pack/README.md) |
| Compatibility baseline | [`compat/README.md`](./compat/README.md) |
| API compatibility layer & scanner | [`shim/README.md`](./shim/README.md) |
| Test fixtures | [`tests/README.md`](./tests/README.md) |
| Check script | [`ci/README.md`](./ci/README.md) |
| Changelog | [`CHANGELOG.md`](./CHANGELOG.md) |
| Contributing | [`CONTRIBUTING.md`](./CONTRIBUTING.md) |
| Security policy | [`SECURITY.md`](./SECURITY.md) |

## License

[MIT](./LICENSE) © ElecMini contributors
