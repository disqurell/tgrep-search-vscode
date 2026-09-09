# Changelog

## 0.1.5

- Add platform packages for macOS, Linux, Alpine and Windows, each on x64 and ARM64, under one extension ID.
- Use LockFileEx, a Job Object and Unicode process arguments on Windows; retain POSIX flock on macOS/Linux.
- Add an eight-target build workflow and test the extracted VSIX with real tgrep and an empty PATH.
- Package only the matching helper; preserve executable permissions and exclude development files.

## 0.1.4

- Remove the separate Python dependency. The extension now needs only VS Code and tgrep on macOS Apple Silicon.
- Bundle a small native POSIX lock supervisor; validate index metadata with the VS Code JavaScript runtime.
- Preserve external flock compatibility, cancellation, process cleanup on host death and locks through completion recording.
- Remove `tgrepSearch.pythonExecutable`. Existing folder bindings continue to work. Old completion receipts use a labelled metadata estimate until the next successful rebuild.
- Package for `darwin-arm64`; other platforms need their own builds and validation.

## 0.1.3

- Add English/Russian language selection and compact settings by default.
- Refine theme-aware panel styling.
- Provide indexed content/file search, index status, source/index folder selection, manual rebuilding and completion timestamps.
