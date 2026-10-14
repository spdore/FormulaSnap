# Architecture

FormulaSnap uses Tauri 2 to host a React and TypeScript interface. The frontend coordinates the recognition workflow and previews. Rust provides operating-system integration, credential storage, online requests, and local OCR process management.

## Data flow

~~~text
Screen capture / clipboard / image file
                 |
                 v
        Image preview and crop
                 |
       Rotate, sharpen, remove background
                 |
                 v
            Provider selection
        /          |           \
       v           v            v
 Local OCR      Vision API    Codex CLI
 ONNX runtime     HTTPS       CLI to cloud
        \          |           /
                 v
       LaTeX to MathML / plain text / OMML
                 |
        Preview, copy, or export
                 |
        IndexedDB history and preferences
~~~

## Module boundaries

| Module | Responsibility |
| --- | --- |
| app/src/App.tsx | Main UI, page navigation, single and batch workflows, application feedback |
| app/src/batch-engine.ts | Batch preference migration, immutable run snapshots, and explicit provider routing |
| app/src/components/SelectMenu.tsx | Styled selection menus with keyboard navigation, edge positioning, and focus management |
| app/src/bridge.ts | Tauri commands, file and clipboard operations, formula-image copy, and export bridges |
| app/src/image-tools.ts | Cropping, rotation, image enhancement, and formula-region processing |
| app/src/recognition-service.ts | Recognition configuration and provider task dispatch |
| app/src/formats.ts | Recursive LaTeX parsing, KaTeX MathML, plain-text and OMML serializers |
| app/src/word-export.ts | JSZip DOCX packaging with Office Math structures |
| app/src/storage.ts | IndexedDB preferences, batch queue, and recognition history |
| app/src-tauri/src/api.rs | Vision API requests and system credential references |
| app/src-tauri/src/codex.rs | Codex CLI discovery, login status, isolated task inputs and outputs, cancellation, and diagnostics |
| app/src-tauri/src/local.rs | Runtime installation, model preparation, Python worker lifecycle, and progress |
| app/src-tauri/src/lib.rs | Tauri commands, state registration, and plugin setup |

## Recognition routing

Single and batch recognition explicitly route to the selected local, API, or Codex CLI provider. A batch run freezes the selected engine and required settings when it starts. Only local recognition prepares a Python environment. API or Codex failures do not silently fall back to another provider.

Successful batch items retain their actual service, model, backend, and history recordId. Opening a result reuses the main preview and export workflow without issuing another recognition request.

API keys are stored by Rust in the operating-system credential store. They are not stored in IndexedDB or diagnostic logs. Codex authentication is managed by the Codex CLI. Local Python workers use JSON Lines over stdin/stdout; Rust drains stderr asynchronously into bounded, redacted diagnostics. Windows background tools are created without visible console windows. Miniforge installers also receive their own quiet-mode arguments.

## Formula conversion

app/src/formats.ts parses LaTeX into a recursive expression tree. It matches nested environments and handles row, group, and cell boundaries at the appropriate level. Syntax errors and output-format capability errors are reported separately.

KaTeX handles preview and MathML. Plain text and OMML use separate serializers, so an OMML limitation does not block plain-text conversion. The aligned environment becomes an Office Math equation array; matrices, simple arrays, and cases use matrix structures. The parser preserves mathcal font semantics, hat accents, scripts, fractions, delimiters, and text spacing within the documented subset. See [docs/FORMATS.md](docs/FORMATS.md).

The DOCX exporter constructs Office Math nodes; it does not substitute formula images. Automated tests inspect ZIP parts and XML structure. A Microsoft Word desktop session is still required to confirm Word's repair behavior, rendering, and editing experience.

## Data and credentials

Recognition history and preferences are stored in IndexedDB. The installed application stores owned runtime files, models, caches, and diagnostics in FormulaSnapData beside the release executable. Desktop acceptance can set FORMULASNAP_DATA_DIR to a unique workspace-local directory; the WebView2 profile is redirected to its webview subdirectory.

FormulaSnap does not read or copy Codex CLI credential files. The CLI may manage a short-lived tmp/arg0 alias in the user's existing CODEX_HOME while locating its saved login. This is controlled by the CLI itself and is documented in docs/MODELS.md.

## Windows packaging

Tauri builds the Windows x64 GUI executable and NSIS installer. Bundler download caches are stored under the Cargo target's .tauri directory. The workspace launcher reads .toolchain/active-release.txt. The installed Start Menu shortcut points directly to the release GUI executable.

The 0.1.6 release added explicit batch-provider selection and immutable configuration snapshots. Version 0.1.7 added recursive formula parsing and independent text/OMML conversion. Version 0.1.8 added hat-accent conversion. See CHANGELOG.md and docs/TESTING.md for release details and verification limits.
