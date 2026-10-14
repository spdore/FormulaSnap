# Development Guidelines

## Product and UI

- Use the latest user-approved three-column blue-and-white FormulaSnap design as the visual reference. Do not use older concept images as the design baseline.
- The main workflow is capture, paste, or open a formula image; crop and preprocess it; recognize it; switch output formats; copy or export; and revisit history.
- User-facing interface text is Simplified Chinese. LaTeX, MathML, and formula content retain their native syntax.

## Workspace and data boundaries

- Keep source changes, generated files, temporary files, test output, tool caches, and build caches inside the repository.
- Keep local runtime data under the ignored .runtime directory during development. Keep tool and compiler caches under the ignored .toolchain directory.
- The installed application stores owned models, runtimes, caches, and diagnostics beside the release executable in FormulaSnapData. Development and desktop acceptance must set FORMULASNAP_DATA_DIR to a unique repository-local directory.
- Do not move a Conda environment that has a FormulaSnap ownership marker; Conda environments contain absolute prefixes and cannot be relocated safely.
- The workspace launcher reads .toolchain/active-release.txt. This pointer must resolve to a release executable inside the repository. FormulaSnap-Workspace.exe launches that release and redirects application data, WebView2 profile, and caches into the workspace.
- Launch-FormulaSnap.ps1 accepts only a repository-local data directory and is the desktop acceptance entry point. Launch-FormulaSnap.bat is for development use.
- The installed Start Menu and desktop shortcuts must point directly to the Tauri release GUI executable. Do not use a batch file, Command Prompt, or visible PowerShell as the installed entry point.
- Keep Miniforge installs silent with both /S and /Q. The absolute /D= target remains the final installer argument. CREATE_NO_WINDOW does not replace installer quiet mode.
- Store API keys only in the system credential store. Never put credentials in source, ordinary JSON, logs, test results, or documentation.
- Never delete, move, or modify files outside the repository. Cleanup may affect only files created by the current task inside the repository.

The Codex CLI may create and remove its own short-lived tmp/arg0 alias under the user's existing CODEX_HOME while locating saved login state. FormulaSnap must not redirect, copy, inspect, or clean the CLI's credentials or CLI-owned temporary directory. See docs/MODELS.md.

## Implementation boundaries

- React and TypeScript UI live in frontend/src. Tauri commands and platform integration live in frontend/src-tauri/src.
- Keep image processing, format conversion, Word export, and persistence responsibilities separate.
- Local recognition uses JSON Lines over stdin/stdout. Keep stdout machine-readable; drain stderr asynchronously into bounded, redacted workspace diagnostics.
- Create Windows background processes without visible consoles. Configure installer quiet behavior separately.
- Download progress percentages represent only downloads with a known content length. Show installation and extraction as named stages; show an ETA only when measured data supports it.
- Integrate Codex through the public codex login status and codex exec commands. Use a read-only sandbox, an ephemeral session, workspace task files and logs, a JSON Schema final response, and disable MCP servers and plugins. Codex CLI runs locally, but recognition is processed by Codex cloud services.
- Batch runs must use a frozen engine configuration. Each successful item must retain its true history recordId and provider metadata. Opening a batch result must not trigger recognition.
- The built-in DeepSeek vision preset must not require a separate image-validation request. The first real image request is the recognition request; API keys remain in the system credential store.
- Provider errors must be visible to users without exposing secrets.
- Plain text and OMML support a defined LaTeX subset. Report unsupported commands and environments clearly; never silently drop formula content.

## Windows verification commands

Run from the repository root. Keep all cache and output paths under .toolchain. Run the frontend steps in order, then Rust tests.

~~~powershell
$workspace = (Get-Location).Path
$env:TEMP = Join-Path $workspace '.toolchain\tmp'
$env:TMP = $env:TEMP
$env:CARGO_HOME = Join-Path $workspace '.toolchain\cargo'
$env:RUSTUP_HOME = Join-Path $workspace '.toolchain\rustup'
$env:npm_config_cache = Join-Path $workspace '.toolchain\npm-cache'
$env:PIP_CACHE_DIR = Join-Path $workspace '.toolchain\pip-cache'
$env:CARGO_TARGET_DIR = Join-Path $workspace '.toolchain\cargo-target-0.1.8-hat-accent'
$env:Path = (Join-Path $workspace '.toolchain\rustup\toolchains\stable-x86_64-pc-windows-msvc\bin') + ';' + $env:Path

Push-Location frontend
npm --cache $env:npm_config_cache test
npm --cache $env:npm_config_cache run lint
npm --cache $env:npm_config_cache run build
Pop-Location
cargo test --offline --manifest-path frontend/src-tauri/Cargo.toml
~~~

## Repository facts

- The release application uses Tauri 2, React, TypeScript, and Rust.
- The Windows x64 release target is .toolchain/cargo-target-0.1.8-hat-accent.
- This repository contains a public synthetic Gaussian-integral test fixture; never add user formula images or local application data.
- This project does not rely on an existing Git history for its release source.
