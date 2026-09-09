# tgrep Search

A separate VS Code sidebar for indexed **content search** and file-name search with Microsoft tgrep. The panel shows the selected source folder, index folder, index health and the last successful update time. Indexing starts only when you request it.

Документация на русском: `README.ru.md` (включена в расширение).

## Install

Requirements: VS Code 1.95+, **Microsoft tgrep 1.0.5**, and Python 3 with `fcntl` on macOS or Linux. Tested on macOS arm64. Windows is not supported. The VSIX does not bundle tgrep or Python.

Use **Extensions: Install from VSIX…**, or run from this repository:

```sh
code --install-extension artifacts/tgrep-search-0.1.3.vsix
```

The extension ID is `local-tools.tgrep-search`. It uses stable VS Code APIs and requires a trusted filesystem workspace. For Remote SSH, install the prerequisites on the Extension Host machine; remote operation has not been tested.

Set `tgrepSearch.executable` if needed. The default searches PATH, then `~/.local/bin/tgrep`; `~/` is expanded for the current user. `tgrepSearch.pythonExecutable` defaults to `python3`. Both settings accept an executable path, not a shell command.

## Use

1. Open the tgrep Activity Bar view, or press **Cmd+Alt+F** on macOS / **Ctrl+Alt+F** on Linux.
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

Status is checked every five seconds and through **Check**, including updates performed outside VS Code. The status bar shows a compact state and time; its tooltip includes full details. Clicking it opens the panel; the adjacent refresh icon starts a rebuild.

## Hidden files and safe rebuilding

Build arguments are equivalent to:

```sh
tgrep index <source> --hidden --exclude .git --index-path <index>
```

Hidden files and folders are included. Ignore rules retain tgrep's semantics; `--no-ignore` is never added. Outside a Git repository, tgrep may not apply `.gitignore`.

Content search uses `--json --line-buffered`, the selected match options, `--regexp=<query>` and `-- <source>`. All arguments are passed as arrays through `spawn` / `subprocess.Popen`, without a shell. Spaces, Unicode, shell-looking text and leading hyphens remain data.

Search deliberately does **not** pass `--hidden`: in tgrep 1.0.5 that flag bypasses the prebuilt index. The extension never starts `serve`. It rejects indexes containing `serve.json`, since tgrep would otherwise auto-connect to a server. Stop the server and remove stale server metadata yourself before connecting a disk index.

The Python helper holds shared POSIX flock locks during search and exclusive locks throughout a build. Lock files are adjacent to the index: `<index-name>.tgrep-search.lock` and `<index-name>-update.lock`. Reading requires permission to open/create these lock files. Their presence does not indicate a held lock; the operating-system flock state does. Different indexes can build independently.

An external updater must hold an **exclusive `fcntl.flock` on the same external lock file for the entire `tgrep index` process**. Set `tgrepSearch.externalLockPath` when its lock is elsewhere. No external updater or scheduler is invoked or modified by the extension. A nonblocking updater may skip a run while a search holds the lock.

Before building, `.tgrep-search-building.json` marks the index as unfinished. Failure or cancellation leaves that marker, blocking searches until a successful extension rebuild. The previous successful timestamp is not overwritten. Builds run in place without a backup generation. A nonempty unrelated folder without tgrep metadata cannot be overwritten.

Arbitrary external `tgrep index` processes that ignore the agreed flock cannot be fully synchronized: tgrep 1.0.5 does not acquire these locks itself. Checks before and after search detect many inconsistent writes and discard results, but do not replace the shared locking protocol. Use the agreed lock to prevent partial-index reads.

## Limits

- Searches read saved files, not unsaved buffers. Newly added or edited files can be missed until the next index update. There is no automatic rebuilding, live server, replacement operation or multiline search.
- `maxResults` defaults to 1,000 lines/files, up to 10,000. `maxOutputMB` defaults to 8 MiB, up to 32 MiB. Reaching either limit stops the process and marks the results incomplete. A record over 1 MiB produces an error; the preview shows at most 2,000 characters per line.
- Output is parsed asynchronously and bounded in memory. Results are published after completion or a limit, rather than per row. A newer query rejects late results from older ones.
- Cancellation terminates the process group, escalating to SIGKILL after two seconds. Extension Host shutdown also ends the child work.
- JSON UTF-8 byte offsets are converted to UTF-16 editor positions. Cyrillic and emoji are tested. Unusual encodings depend on matching decoding in tgrep and VS Code; non-UTF-8 file names are unsupported.
- Windows, Remote SSH, nonstandard network-filesystem flock behavior and other tgrep versions are untested.

## Development and verification

```sh
npm ci
npm test
npm run test:integration
npm run test:ui
npm run test:host
npm run package
```

Tests use temporary corpora under `.scratch`, not external projects. `test:integration` uses `TGREP_EXECUTABLE` or `~/.local/bin/tgrep`. `test:ui` requires Google Chrome and tests real panel HTML/CSS/JS with a simulated VS Code bridge. `test:host` launches the installed VS Code with isolated user data/extensions under `.scratch/host`; `VSCODE_EXECUTABLE` can override the application path. An F5 configuration is provided.

Native folder-picker dialogs and physical global shortcuts are not automated. The UI tests cover both languages, keyboard submission, accessibility labels, safe rendering, collapsed defaults and live language switching, compact status and state restoration. Extension Host tests cover activation, building, actual search and editor navigation.

Implementation references: [tgrep metadata](https://github.com/microsoft/tgrep/blob/v1.0.5/tgrep-core/src/meta.rs), [index publication](https://github.com/microsoft/tgrep/blob/v1.0.5/tgrep-core/src/builder.rs), [disk search](https://github.com/microsoft/tgrep/blob/v1.0.5/tgrep-cli/src/search.rs), [JSON offsets](https://github.com/microsoft/tgrep/blob/v1.0.5/tgrep-cli/src/output.rs), [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview), [extension manifest localization](https://code.visualstudio.com/api/references/extension-manifest).
