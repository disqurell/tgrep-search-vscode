# tgrep Search

A separate VS Code sidebar for indexed **content search** and file-name search with Microsoft tgrep. The panel shows the selected source folder, index folder, index health and the last successful update time. Indexing starts only when you request it.

Документация на русском: `README.ru.md` (включена в расширение).

## Install

Requirements: **VS Code 1.95+ and Microsoft tgrep 1.0.5**. Install the extension and tgrep; no separate Python, Node.js, compiler or Homebrew installation is needed to use it. JavaScript runs inside VS Code and the native lock supervisor is bundled in each VSIX.

All builds use the same extension ID and version. Once published to Marketplace, VS Code chooses the matching platform package automatically for installation and updates. GitHub builds alone do not publish to Marketplace.

| System | x64 package target | ARM64 package target |
| --- | --- | --- |
| macOS 11+ | `darwin-x64` | `darwin-arm64` |
| Linux (glibc 2.31+ build baseline) | `linux-x64` | `linux-arm64` |
| Alpine Linux (musl; static helper) | `alpine-x64` | `alpine-arm64` |
| Windows 10/11 | `win32-x64` | `win32-arm64` |

The installed VS Code version and tgrep may impose newer OS requirements. 32-bit systems and browser-only VS Code are unsupported. In Remote SSH / WSL / containers, install the package for the **Extension Host** system, not the local desktop. A Windows native extension and a WSL extension use different packages and separate locking protocols.

Use **Extensions: Install from VSIX…** with the matching filename, or run this macOS Apple Silicon example from the repository:

```sh
code --install-extension artifacts/tgrep-search-0.1.5-darwin-arm64.vsix
```

The extension ID is `local-tools.tgrep-search`. It uses stable VS Code APIs and requires a trusted filesystem workspace. For Remote SSH the Extension Host must match the package platform and have tgrep installed; remote operation has not been tested.

Set `tgrepSearch.executable` if needed. The default searches PATH, then `~/.local/bin/tgrep`; `~/` is expanded for the current user. The setting accepts an executable path, not a shell command. The old `tgrepSearch.pythonExecutable` setting is no longer used and can be removed.

## Use

1. Open the tgrep Activity Bar view, or press **Cmd+Alt+F** on macOS.
2. **Choose source folder…** selects the folder to index. **Projects…** selects a workspace root in a multi-root workspace. The active project is explicit and does not change when you switch editors.
3. Independently **Choose index folder…** to connect an existing index or select an empty directory. The default index location is a unique folder in extension global storage, derived from the canonical source path. Keep the index outside the source folder to avoid indexing the index itself.
4. Click **Build / update** when you want to create or rebuild the index. Progress, cancellation and a log are available in the panel and the `tgrep Search` output channel.
5. Enter a query and press Enter or **Search**. Content search defaults to literal, case-sensitive matching. Regex and case toggles are available. The path filter accepts one glob, such as `**/*.php`, `!**/test/**` or `**/*.{php,ts}`.
6. Results are grouped by file. Click a matching line to open the editor and select the first match. All matches are highlighted in the result. **Cmd+Alt+Shift+F** / **Ctrl+Alt+Shift+F** searches the selected text literally; the editor context menu offers the same command.

**File names (glob)** is a separate mode using `--files --null`. The query is a glob; leave it empty to list indexed files up to the limit. This mode does not search contents.

## Expanded and compact settings

Settings are **hidden whenever the panel loads**. The compact status/date and search remain visible. Query text and search options are restored; expand **Settings** when you need the folder or build controls.

**Collapse** hides the folder/build settings and detailed index status, leaving search and a compact status/date indicator. **Settings** expands them again, including access to build cancellation. The compact indicator shows ✓ for a ready index, ↻ for a build/busy index, and ⚠ for a missing or invalid index. An estimated time is marked ≈; the tooltip includes full status, time provenance and both folder paths.

Set **tgrep Search › Language** (`tgrepSearch.language`) in VS Code settings: `auto`, `en`, or `ru`. The panel and extension/helper messages update immediately, preserving your query. `auto` follows VS Code's display language with English fallback. Command titles and configuration descriptions follow VS Code's display language. Raw tgrep output and operating-system errors are shown as supplied.

The panel uses compact spacing, subtle translucent surfaces and soft borders. Colors come from the VS Code theme, with opaque high-contrast styling and reduced-transparency support.

## Index ownership and timestamps

Source-to-index bindings live in VS Code `workspaceState`, scoped to the current workspace and canonical source path. A new workspace gets its own selection and bindings. Multi-root selection also accounts for the workspace folder set. There are no built-in project names, corpus locations or user updater commands.

Existing indexes are validated using `meta.json.root_path` with symlinks resolved, format `version=2`, completeness, required binary files, lookup sizes and publication order. An index belonging to another root cannot be searched or overwritten. The extension does not silently fall back to filesystem scanning when the index is missing or invalid.

- **Confirmed by the extension**: recorded only after the indexing process exits with code 0 and the output passes validation. `.tgrep-search-completed.json` stores the UTC completion time and a fingerprint of that generation. The UI displays a date and local time; command start or panel load is never treated as successful completion.
- **meta.updated_at; estimated external build completion**: the actual Unix-seconds field from tgrep. In 1.0.5 it is assigned before all sidecar writes complete, so the UI labels it as an estimate. An external generation change invalidates the previous extension receipt.
- Missing metadata time falls back to an explicitly labelled **meta.json mtime estimate**. Unavailable times are **unknown**. During an error or lock, a previously observed successful update can remain labelled **last known**.

After upgrading from 0.1.3, old completion receipts fall back to a labelled metadata estimate until the next successful extension rebuild. Version 0.1.4 stores nanosecond fingerprints as decimal strings to avoid JavaScript number rounding. An old receipt can still be shown as the last known time during an error.

Status is checked every five seconds and through **Check**, including updates performed outside VS Code. The status bar shows a compact state and time; its tooltip includes full details. Clicking it opens the panel; the adjacent refresh icon starts a rebuild.

## Hidden files and safe rebuilding

Build arguments are equivalent to:

```sh
tgrep index <source> --hidden --exclude .git --index-path <index>
```

Hidden files and folders are included. Ignore rules retain tgrep's semantics; `--no-ignore` is never added. Outside a Git repository, tgrep may not apply `.gitignore`.

Content search uses `--json --line-buffered`, the selected match options, `--regexp=<query>` and `-- <source>`. All arguments are passed as arrays through `spawn` / POSIX `execvp`, without a shell. Spaces, Unicode, shell-looking text and leading hyphens remain data.

Search deliberately does **not** pass `--hidden`: in tgrep 1.0.5 that flag bypasses the prebuilt index. The extension never starts `serve`. It rejects indexes containing `serve.json`, since tgrep would otherwise auto-connect to a server. Stop the server and remove stale server metadata yourself before connecting a disk index.

On macOS/Linux the bundled native supervisor holds shared POSIX `flock` locks during search and exclusive locks throughout a build, including the final validation and completion receipt. Index validation uses the Node.js runtime built into VS Code. The supervisor is not tied to the Node.js ABI. On Windows it uses `LockFileEx` on byte range `[0,1)` of both lock files, shared for reads and exclusive for builds, with immediate failure on contention. It owns child processes through a kill-on-close Job Object. Lock files are adjacent to the index: `<index-name>.tgrep-search.lock` and `<index-name>-update.lock`. Reading requires permission to open/create these lock files. Their presence does not indicate a held lock; the operating-system flock state does. Different indexes can build independently.

An external updater must hold an **exclusive POSIX `flock` on the same external lock file for the entire `tgrep index` process** (including Python updaters that already use `fcntl.flock`). Set `tgrepSearch.externalLockPath` when its lock is elsewhere. On Windows an external updater must instead use the same `LockFileEx` byte range and hold it throughout indexing. POSIX/WSL flock and native Windows locks are not interchangeable; do not share a writable index across these environments. No external updater or scheduler is invoked or modified by the extension. A nonblocking updater may skip a run while a search holds the lock.

Before building, `.tgrep-search-building.json` marks the index as unfinished. Failure or cancellation leaves that marker, blocking searches until a successful extension rebuild. The previous successful timestamp is not overwritten. Builds run in place without a backup generation. A nonempty unrelated folder without tgrep metadata cannot be overwritten.

Arbitrary external `tgrep index` processes that ignore the agreed flock cannot be fully synchronized: tgrep 1.0.5 does not acquire these locks itself. Checks before and after search detect many inconsistent writes and discard results, but do not replace the shared locking protocol. Use the agreed lock to prevent partial-index reads.

## Limits

- Searches read saved files, not unsaved buffers. Newly added or edited files can be missed until the next index update. There is no automatic rebuilding, live server, replacement operation or multiline search.
- `maxResults` defaults to 1,000 lines/files, up to 10,000. `maxOutputMB` defaults to 8 MiB, up to 32 MiB. Reaching either limit stops the process and marks the results incomplete. A record over 1 MiB produces an error; the preview shows at most 2,000 characters per line.
- Output is parsed asynchronously and bounded in memory. Results are published after completion or a limit, rather than per row. A newer query rejects late results from older ones.
- On macOS/Linux cancellation terminates the process group, escalating to SIGKILL after two seconds. Windows cancellation terminates the entire Job Object immediately. Extension Host shutdown also ends child work.
- JSON UTF-8 byte offsets are converted to UTF-16 editor positions. Cyrillic and emoji are tested. Unusual encodings depend on matching decoding in tgrep and VS Code; non-UTF-8 file names are unsupported.
- Interactive UI checks cover macOS; Windows/Linux backend checks run separately. Remote SSH, nonstandard network-filesystem locks and other tgrep versions are untested.

## Development and verification

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
