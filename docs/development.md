# Development and platform support

[← Quickstart](../README.md) · [Быстрый старт на русском](../README.ru.md)

## Platforms

All builds use the same extension ID and version. Once published to Marketplace, VS Code chooses the matching platform package automatically for installation and updates. GitHub builds alone do not publish to Marketplace.

| System | x64 package target | ARM64 package target |
| --- | --- | --- |
| macOS 11+ | `darwin-x64` | `darwin-arm64` |
| Linux (glibc 2.31+ build baseline) | `linux-x64` | `linux-arm64` |
| Alpine Linux (musl; static helper) | `alpine-x64` | `alpine-arm64` |
| Windows 10/11 | `win32-x64` | `win32-arm64` |

The installed VS Code version and tgrep may impose newer OS requirements. 32-bit systems and browser-only VS Code are unsupported. In Remote SSH / WSL / containers, install the package for the **Extension Host** system, not the local desktop. A Windows native extension and a WSL extension use different packages and separate locking protocols.

Validation for 0.1.5: macOS ARM64 passes the real VS Code Host test; macOS x64 passes backend/package tests under Rosetta. Linux and Alpine pass backend/package tests on ARM64 and x64 in Docker. Both Windows binaries cross-compile, but native Windows runtime/CI validation is still pending; treat those packages as experimental until the corresponding Actions jobs pass. The workflow builds Windows with MSVC; local preliminary Windows artifacts were built with LLVM-MinGW and use the system UCRT.

## Build and test

Building from source requires Node.js/npm and a native compiler: Apple Command Line Tools on macOS, a C compiler on Linux, or an MSVC Developer shell on Windows (matching the target CPU). These are development requirements only. `npm run compile` builds TypeScript and the appropriate C helper; `npm run package` includes only that target helper. Generated binaries remain ignored by Git. No code or runtime is downloaded during extension activation.

`.github/workflows/build.yml` builds eight targets on matching CPU runners or Linux containers. Every job runs unit/process tests, downloads official tgrep 1.0.5 with a pinned SHA-256 for integration tests, then extracts and tests the actual VSIX with an empty PATH. Packages are uploaded as Actions artifacts; publication to Marketplace is a separate explicit step. `TGREP_TARGET` selects the target during builds (cross-compiling both macOS architectures is supported). Linux containers use `node:22-bullseye`; Alpine uses `node:22-alpine` and a static helper. Run `node scripts/test-container.cjs linux-arm64` locally with Docker to reproduce a Linux job.

```sh
npm ci
npm test
npm run test:integration
npm run test:ui
npm run test:host
npm run package
```

Tests use temporary corpora under `.scratch`, not external projects. `test:integration` uses `TGREP_EXECUTABLE` or `~/.local/bin/tgrep`. `test:ui` requires Google Chrome and tests real panel HTML/CSS/JS with a simulated VS Code bridge. `test:host` launches the installed VS Code with isolated user data/extensions under `.scratch/host`; `VSCODE_EXECUTABLE` can override the application path. An F5 configuration is provided.

The native tests cover shared/exclusive locks, cancellation, parser failure and forced Extension Host death. A packaged-extension Host run with an empty PATH verifies that Python, Node.js executables and a compiler are not required at runtime. Set `TGREP_TEST_NO_TOOLS=1` to repeat it; only the configured absolute tgrep path and the bundled helper are used.

Native folder-picker dialogs and physical global shortcuts are not automated. The UI tests cover both languages, keyboard submission, accessibility labels, safe rendering, collapsed defaults and live language switching, compact status and state restoration. Extension Host tests cover activation, building, actual search and editor navigation.

Implementation references: [tgrep metadata](https://github.com/microsoft/tgrep/blob/v1.0.5/tgrep-core/src/meta.rs), [index publication](https://github.com/microsoft/tgrep/blob/v1.0.5/tgrep-core/src/builder.rs), [disk search](https://github.com/microsoft/tgrep/blob/v1.0.5/tgrep-cli/src/search.rs), [JSON offsets](https://github.com/microsoft/tgrep/blob/v1.0.5/tgrep-cli/src/output.rs), [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview), [extension manifest localization](https://code.visualstudio.com/api/references/extension-manifest).
