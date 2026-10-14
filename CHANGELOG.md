# Changelog

## 0.1.8 — 2026-10-14

- Added support for the LaTeX hat accent. Plain text uses a Unicode combining accent for a single character and hat(...) for compound content. DOCX output uses an editable OMML accent node.
- Added regression tests for single and compound accents, scripts, and aligned formulas.
- Verification: 30 frontend tests passed; Oxlint, the TypeScript/Vite production build, and Rust offline tests passed. The Windows x64 release executable and NSIS package were built. See HANDOFF.md for artifact hashes and manual verification limits.

## 0.1.7 — 2026-10-14

- Added recursive parsing for nested LaTeX environments, groups, row boundaries, and cell boundaries. Added aligned and simple l/c/r array support.
- Exported aligned formulas as Office Math equation arrays and kept matrix and cases semantics.
- Added mathcal Unicode/script styling, text spacing, left/right delimiters, and indexed radicals.
- Separated plain-text and OMML serialization and displayed format-specific conversion errors.
- Added structural DOCX and formula conversion regression tests. Automated build and test results are recorded in docs/TESTING.md. Microsoft Word desktop behavior was not verified.

## 0.1.6 — 2026-10-14

- Added an independent batch engine selector for local OCR, configured API services, and Codex CLI.
- Persisted batch preferences and froze a per-run engine and service snapshot.
- Added explicit provider dispatch, real history record association, and provider metadata for batch results.
- Added provider routing and configuration snapshot tests. A Codex CLI live test used two formula images; DeepSeek live API testing was not run.

## 0.1.5 — 2026-10-14

- Fixed repeated Windows virtual drive mappings by normalizing extended paths and comparing mapped workspace targets correctly.
- Added path handling regression tests.

## 0.1.4 — 2026-10-14

- Added batch result previews linked to history records, source metadata, edit synchronization, and navigation back to the queue.
- Added Codex CLI recognition through its public login status and non-interactive image request commands. The CLI owns authentication; FormulaSnap does not read or copy tokens.
- Removed the mandatory image-validation gate from the built-in DeepSeek vision preset.
- Added JSONL parsing, CLI argument, and provider tests.

## 0.1.3 — 2026-10-14

- Added measured download progress, transfer speed, timeout handling, provider failover, and persistent retry feedback for local environment setup.
- Added regional package mirror selection while retaining pinned official Miniforge and model downloads.
- Moved installed runtime data beside the application and added a workspace release pointer.
- Added model, device, and worker health states and a guarded environment-rebuild flow.

## 0.1.2 — 2026-10-14

- Added Miniforge quiet installation arguments and process diagnostics.
- Added a GUI-subsystem workspace launcher and direct release executable shortcuts.

## 0.1.1 — 2026-10-13

- Pinned the Miniforge release and verified its download size and SHA-256.
- Isolated installer, Conda, pip, Python, and OCR worker environments.
- Added process locking, timeouts, retry feedback, and ownership-marker cleanup.
- Changed formula-image clipboard copying to use canvas pixel data and bundled KaTeX fonts.
- Unified application confirmation dialogs and selection menus.
- Added desktop DOCX save handling and workspace-local build caches.

## 0.1.0 — 2026-10-13

- Implemented the three-column blue-and-white desktop workspace.
- Added image capture, clipboard and file import, cropping, image enhancement, formula recognition, and format previews.
- Added the RapidLaTeXOCR local runner and configurable vision APIs.
- Added batch recognition, history, settings, and LaTeX, MathML, plain-text, and DOCX export workflows.
- Added frontend and Rust tests and built a Windows x64 NSIS installer.

This history records project changes. See docs/TESTING.md for the scope and limits of release verification.
