# Contributing to ElecMini

Thanks for your interest in improving ElecMini. This document explains how to set up a
development environment, run the checks, and submit changes.

## Development prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22+ | Runtime sidecar and tooling |
| Rust | stable | Host crate (`tao` + `wry`) |
| Linux | `libwebkit2gtk-4.1-dev` | Required to build/run the WebKitGTK host |
| macOS / Windows | system WebView | WKWebView / WebView2, no extra dev package |

## Setup

```bash
git clone https://github.com/outman2008/elecmini.git
cd elecmini
npm install
cargo build --release -p elecmini-host --bin elecmini-host
```

## Running the checks

The single entry point for local and CI checks is `ci/check.sh`:

```bash
bash ci/check.sh            # full suite (build, lint, unit tests, differential contract, E2E)
bash ci/check.sh --quick    # quick: skips build and E2E (unit tests + lint only)
```

Full E2E on Linux requires `xvfb-run`; install it via `sudo apt-get install xvfb`.
The same script runs in GitHub Actions across Linux, Windows, and macOS.

## Code style

- **JavaScript**: ESLint + Prettier. Run `npm run lint` and `npm run format:check`.
- **Rust**: `cargo fmt --check` and `cargo clippy -- -D warnings`.
- Keep API additions aligned with the Electron contract. When adding an Electron API member,
  register its tier in `runtime/contract-fill.js` (native / mirror / degraded) and update
  `docs/unsupported-apis.md` if it is degraded or unsupported.

## Adding an Electron API

1. Implement the member in the appropriate `runtime/modules/*.js` file if it can be backed
   by the Rust host or a state mirror.
2. If it must exist for contract completeness but cannot be truly implemented, register a
   **type-correct** degraded stub in `runtime/contract-fill.js` with a clear reason — never
   return a `Promise` from a synchronous Electron API.
3. Add a unit test under `runtime/modules/modules.test.js` or a contract check in
   `migrate/api-surface/contract-fill.test.js`.
4. Verify with `node migrate/api-surface/audit.js` and `bash ci/check.sh --quick`.

## Migrating a real application

See [`migrate/README.md`](./migrate/README.md) for the four-step assessment workflow
(static scan → differential contract → packaging → L0 coverage). Report findings with
reproducible commands; do not commit generated reports or target-application source.

## Submitting changes

1. Fork the repository and create a feature branch.
2. Make focused changes with tests; ensure `bash ci/check.sh --quick` passes.
3. Open a pull request describing the problem, the approach, and how you verified it.

## Security issues

Do **not** open a public issue for security vulnerabilities. See [`SECURITY.md`](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
