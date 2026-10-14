# Changelog

## 0.1.8 — 2026-10-14

- Added LaTeX `\hat` accents to plain-text and editable Word formula output.
- Improved formula conversion coverage for compound accents, scripts, and aligned equations.
- The Windows x64 installer is available from [GitHub Releases](https://github.com/spdore/FormulaSnap/releases).

## 0.1.7 — 2026-10-14

- Added nested LaTeX parsing, `aligned` and simple `array` support, and improved matrices and cases conversion.
- Added editable Office Math equation arrays for aligned formulas.
- Preserved font semantics for `\mathcal`, text spacing, delimiters, and indexed radicals.
- Separated plain-text and Word conversion so a limitation in one format does not block the other.

## 0.1.6 — 2026-10-14

- Added batch recognition engine selection for local OCR, configured APIs, and Codex CLI.
- Kept each batch run on the selected engine and linked completed items to their saved history records.

## 0.1.5 — 2026-10-14

- Improved Windows path handling for local runtime setup, including long and non-ASCII paths.

## 0.1.4 — 2026-10-14

- Added rendered batch-result previews and direct access to result editing and export.
- Added recognition through the public Codex CLI interface while leaving CLI sign-in credentials under CLI management.
- Removed the extra image-validation step from the built-in DeepSeek vision setup.

## 0.1.3 — 2026-10-14

- Added measured download progress, retry feedback, download-source fallback, and local runtime health states.
- Added automatic selection of configured package mirrors for users in mainland China.

## 0.1.2 — 2026-10-14

- Improved silent local-runtime installation and background process handling.
- Added a GUI-subsystem launcher for workspace testing.

## 0.1.1 — 2026-10-13

- Pinned and verified the local runtime installer and model resources.
- Improved local environment isolation, setup diagnostics, and retry behavior.
- Added offline formula-image clipboard copying and consistent in-app menus and dialogs.

## 0.1.0 — 2026-10-13

- Introduced the three-column FormulaSnap desktop workspace.
- Added screenshot, clipboard, and file image input; cropping and image enhancement; local OCR and vision APIs.
- Added batch recognition, history, LaTeX editing and preview, MathML, plain text, and editable Word export.

See [Testing and acceptance](docs/TESTING.md) for general verification guidance. Release-specific test limits are published with each release when applicable.
