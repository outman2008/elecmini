# Show HN: ElecMini – keep Electron's JS API, drop the 224 MB Chromium

> Draft for `Show HN: ...` submission. Review before posting. Target: https://news.ycombinator.com/newshow
> Repo: https://github.com/outman2008/elecmini · npm: https://www.npmjs.com/package/elecmini

---

## Title options

1. **Show HN: ElecMini – Electron's JS API without the 224 MB Chromium**
2. **Show HN: Run Electron apps on the system WebView (WebView2/WKWebView/WebKitGTK)**
3. **Show HN: An Electron compatibility layer using the OS WebView instead of bundling Chromium**

Pick one. Option 1 leads with the concrete number and tends to perform best on HN.

---

## Submission text

Hi HN,

I built ElecMini, a compatibility layer that keeps the Electron JS API contract but renders with the **system WebView** instead of bundling Chromium. Your app code keeps calling `require('electron')`; underneath, a Rust host (tao + wry) owns the window and WebView, and a Node sidecar runs your main process. They talk over newline-delimited JSON-RPC.

The motivation: I had Electron apps I didn't want to rewrite, but shipping ~224 MB of Chromium for a small tool felt wrong. Tauri solves the size problem but wants a Rust main process and a full rewrite. ElecMini tries the middle path — low-friction migration for existing Electron apps.

**What it actually does**

- **~3x smaller installer**: ~274 MB down to ~84 MB (Slim build), about one third the size — because the browser engine is not bundled.
- Renders with WebView2 (Windows), WKWebView (macOS), or WebKitGTK (Linux) — no bundled browser engine.
- Audits against Electron 45's official `electron.d.ts`: 100% surface coverage of the core 20 modules (984 members total), tiered into native (113) / mirror (327) / degraded (85). Surface coverage is not semantic completeness — the tiers make that explicit.
- Ships a migration toolchain: static AST scan → Go/No-Go estimate → generated runtime probe → differential contract tests (42 cases).
- Startup gate classifies the system WebView (L0–L3) and fails with guidance instead of a blank screen.
- Packaging supports slim/full SKUs, signing, verified auto-update with rollback, and canary bucketing.

**Honest limitations** (please read before trying it):

- **No Electron-grade `contextIsolation`** — preload and page share a realm. Don't treat it as a security sandbox.
- Sync APIs are type-correct degraded stubs (`sendSync` → `undefined`), not real interactions. Chromium extensions and `@electron/remote` are unsupported.
- CDP command protocol is Windows WebView2 only; the DevTools inspector window works on all three platforms (Web Inspector backend on macOS/Linux). L0 ≥95% Go/No-Go still needs production telemetry.

Repo, quick start, and the honest comparison table are here: https://github.com/outman2008/elecmini

I'd especially like feedback on two things: (1) is the native/mirror/degraded tiering the right way to communicate "API compatible" without overpromising, and (2) what would make the migration story credible enough for you to try it on a real app. Happy to answer questions.

---

## Notes for the author (delete before posting)

- Post with a real account that has some history; brand-new accounts often get auto-flagged.
- Do not ask for stars in the post — HN dislikes vote manipulation. The "feedback" close is intentional.
- Reply to every early comment; HN rewards substantive discussion.
- If it gets traction, follow up later with a "what I learned" post rather than reposting this one.
- Best posting window: weekday mornings US Eastern.
