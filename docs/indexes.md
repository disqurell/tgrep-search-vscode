# Indexes and external updates

[← Quickstart](../README.md) · [Быстрый старт на русском](../README.ru.md)

## Ownership and timestamps

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
