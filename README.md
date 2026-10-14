# FormulaSnap

FormulaSnap is a desktop application for recognizing mathematical formulas from screenshots and images. It is built with Tauri 2, React, TypeScript, and Rust, and follows a three-column blue-and-white workspace design.

## Features

- Capture a screen region, paste an image, or open an image file.
- Crop, rotate, sharpen, and remove image backgrounds before recognition.
- Choose among bundled RapidLaTeXOCR, a configured vision API, and the locally installed Codex CLI.
- Run single-image and batch recognition. Batch runs snapshot the selected engine and service configuration.
- Review and edit LaTeX, render formulas with KaTeX, and copy LaTeX, MathML, plain text, or a PNG.
- Export editable Word documents containing Office Math Markup Language (OMML).
- Browse recognition history and reopen linked batch results without recognizing them again.

## Windows release

The current release targets Windows x64. Download the NSIS installer from [GitHub Releases](https://github.com/spdore/FormulaSnap/releases/latest). The installer is currently unsigned.

The RapidLaTeXOCR model weights are included in the installer. The first local setup downloads and installs a pinned Miniforge runtime and Python dependencies into FormulaSnap-managed storage; an Internet connection is required for this one-time setup. Once the environment is ready, local recognition can run offline.

Other recognition options require their own access:

- **Vision API:** Add an API key in Settings. FormulaSnap stores the key in the operating system credential store.
- **Codex CLI:** Install and sign in to the official Codex CLI. FormulaSnap invokes its public commands; image requests are processed by Codex cloud services.

## Build from source

Use Windows PowerShell from the repository root. Build caches and generated application data are directed to ignored folders under the repository.

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
npm --cache $env:npm_config_cache ci
npm --cache $env:npm_config_cache test
npm --cache $env:npm_config_cache run lint
npm --cache $env:npm_config_cache run build
npm --cache $env:npm_config_cache run desktop:build:windows -- -- --offline
Pop-Location

cargo test --offline --manifest-path frontend/src-tauri/Cargo.toml
~~~

The desktop build requires the Rust stable MSVC toolchain, Microsoft C++ Build Tools, and the Tauri prerequisites for Windows. See [docs/TESTING.md](docs/TESTING.md) for the verification record and manual acceptance checks.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Model and provider details](docs/MODELS.md)
- [LaTeX conversion support](docs/FORMATS.md)
- [Testing and release verification](docs/TESTING.md)
- [Current release handoff](HANDOFF.md)
- [Change history](CHANGELOG.md)

## Privacy and licensing

API keys are not included in the source or installer. Local history and settings are stored on the user's device. Codex authentication remains under the Codex CLI; FormulaSnap does not read or copy its credential files.

The repository does not currently include a license grant for FormulaSnap itself. Public availability does not grant permission to reuse or redistribute FormulaSnap source. The bundled RapidLaTeXOCR model files are separately distributed under the upstream MIT license; see the included attribution and license files. Third-party dependencies remain subject to their respective licenses.
