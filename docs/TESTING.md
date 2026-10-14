# Testing and Acceptance

## Release 0.1.8 verification record

Windows build caches, temporary files, and Rust output use repository-local .toolchain directories. The release target is .toolchain/cargo-target-0.1.8-hat-accent.

| Check | Result |
| --- | --- |
| Frontend Vitest | 30 passed across 5 test files. Conversion coverage includes mathcal, hat accents, aligned, arrays, matrices, cases, nested formulas, malformed syntax, and DOCX package structure. |
| Oxlint | Passed. |
| TypeScript and Vite production build | Passed. KaTeX font assets are included. Vite reports that the main JavaScript chunk exceeds 500 kB. |
| Rust offline tests | 21 passed, 0 failed, 2 ignored because those live tests require a DeepSeek key or Codex CLI login. |
| Windows x64 release executable | Built successfully as a GUI-subsystem executable. See HANDOFF.md for size and SHA-256. |
| Windows NSIS package | Built successfully. The installer is unsigned. See HANDOFF.md for size and SHA-256. |
| Microsoft Word desktop | Not tested in this release handoff. |
| Fresh local runtime setup and real inference | Not tested in a new isolated data directory in this release handoff. |

The public test fixture test-data/gaussian-integral.png contains a synthetic Gaussian-integral equation. It is included for smoke tests and is not a user's formula image.

## Reproducible Windows commands

Run from the repository root and keep all generated files under .toolchain.

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

Build the Windows NSIS installer after the verification commands:

~~~powershell
Push-Location frontend
npm --cache $env:npm_config_cache run desktop:build:windows -- -- --offline
Pop-Location
~~~

## Manual acceptance checklist

The following checks remain environment-dependent and should be completed on a Windows desktop before claiming full end-to-end acceptance:

1. Install the NSIS package and verify the Start Menu shortcut opens the release GUI.
2. Use a new repository-local directory with Launch-FormulaSnap.ps1 -DataDirectory .runtime/acceptance-<unique-name>.
3. Verify first-time Miniforge installation, retry after an induced network failure, CPU model loading, and recognition of the Gaussian-integral fixture.
4. Add a second image and verify batch routing, cancel, retry, history association, and restart reuse.
5. Disconnect the network and verify local inference remains available after setup.
6. Verify API recognition using the user's own credential without printing or logging the key.
7. Verify Codex recognition through an existing CLI login; the request is cloud-processed.
8. Copy a formula PNG while offline and paste it into a target application.
9. Open a generated DOCX in Word; check for repair prompts and edit the formula's fraction, scripts, accent, and aligned rows.
10. Inspect application dialogs, menus, keyboard operation, and background process windows.

Do not infer live-provider, installation, Word, GPU, native-window, or other-platform success from unit tests or browser previews. Record platform, data directory, provider, and exact limitations when performing manual acceptance.
