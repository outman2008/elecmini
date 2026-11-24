# Security Policy

## Supported versions

Security fixes are applied to the latest released version.

| Version | Supported |
|---|---|
| 1.0.x | ✅ |
| < 1.0 | ❌ |

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**), or contact the maintainers directly.
Include:

- a description of the issue and its impact,
- the affected version and platform,
- steps to reproduce (a minimal proof of concept is helpful),
- any suggested mitigation.

You should receive an acknowledgement within a few days. Please allow time for a fix
to be released before disclosing publicly.

## Security model — important context

ElecMini intentionally differs from Electron in one security-relevant way:

- **No Electron-grade `contextIsolation`**: the preload script and the page share the same
  JavaScript realm. The `contextBridge` provided by ElecMini is an API-compatibility shim,
  **not** a true cross-realm isolation boundary. Do not rely on it to trust untrusted page
  content.

The runtime mitigates this with:

- **Origin anchoring** in the Rust host: navigation to external origins is anchored and
  tracked.
- **IPC source validation**: IPC messages from untrusted origins are dropped.
- **Strict mode**: set `ELECMINI_STRICT_NAV=1` to block cross-origin navigation entirely.

Recommendations for application authors:

- Load only trusted local content (`app://` / `127.0.0.1`) where possible.
- Keep sensitive operations in the Node sidecar main process behind explicit IPC channels.
- Enable `ELECMINI_STRICT_NAV=1` when your app does not need external navigation.
- Treat renderer input as untrusted regardless of the origin checks above.

For the full list of unsupported / degraded APIs and their security implications, see
[`docs/unsupported-apis.md`](./docs/unsupported-apis.md).
