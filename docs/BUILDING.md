# Build from Source

This guide builds FormulaSnap as a Windows x64 Tauri desktop application.

## Prerequisites

- Windows 10 or Windows 11, 64-bit.
- Node.js and npm.
- Rust stable with the MSVC target.
- Visual Studio Build Tools with the C++ build tools and Windows SDK.
- Microsoft Edge WebView2 Runtime.

Python, Conda, or Anaconda is not needed to compile the app. FormulaSnap prepares its isolated local OCR environment on first use.

## Install dependencies and run the desktop app

From the repository root, open PowerShell:

```powershell
Push-Location app
npm ci
npm run desktop:dev
```

Stop the development app before building the installer.

## Build the Windows installer

Continue from the `app` directory, or open a new PowerShell session there:

```powershell
npm run desktop:build:windows
Pop-Location
```

Unless `CARGO_TARGET_DIR` is set, Tauri writes the installer under `app/src-tauri/target/release/bundle/nsis`. Published installers are available on [GitHub Releases](https://github.com/spdore/FormulaSnap/releases).

## Run automated checks

From the repository root:

```powershell
Push-Location app
npm test
npm run lint
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
Pop-Location
```

See [Testing and acceptance](TESTING.md) for public smoke checks and environment-dependent test requirements. Live API tests require your own API key; Codex tests require your own signed-in CLI. Never put credentials in source files or logs.
