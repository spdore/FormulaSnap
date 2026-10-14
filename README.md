<div align="center">
  <img src="app/src-tauri/icons/icon.png" width="72" alt="FormulaSnap icon">
  <h1>FormulaSnap</h1>
  <p>Capture a formula. Recognize, edit, and export it.</p>
</div>

FormulaSnap is a Windows desktop app that turns formula screenshots and images into editable mathematics. Capture a screen region, paste or open an image, review the result, then copy or export it.

**Current source version: 0.1.8** · Windows x64 · Simplified Chinese interface · Local OCR model included

[Download the Windows installer](https://github.com/spdore/FormulaSnap/releases/tag/v0.1.8) · [All releases](https://github.com/spdore/FormulaSnap/releases) · [Changelog](CHANGELOG.md)

## Download and install

1. Open the [v0.1.8 release](https://github.com/spdore/FormulaSnap/releases/tag/v0.1.8) and download **FormulaSnap_0.1.8_x64-setup.exe**.
2. Optionally verify the file in PowerShell:

   ```powershell
   Get-FileHash .\FormulaSnap_0.1.8_x64-setup.exe -Algorithm SHA256
   ```

   Expected SHA-256: `DD822C56DA12AF866FC95291AF6F4B791D2343CBFDE6343EAEC2E73D85275D09`
3. Run the installer and launch FormulaSnap from its Windows shortcut.

The installer is unsigned, so Windows may display a publisher warning. Confirm that the file came from the FormulaSnap release page before running it.

## What FormulaSnap can do

- Capture a screen region, paste from the clipboard, or open PNG, JPG, and WebP images.
- Crop, rotate, and enhance an image before recognition.
- Recognize formulas with on-device OCR, a configured vision API, or the Codex CLI.
- Process multiple images in a batch and reopen completed results without recognizing them again.
- Edit LaTeX and preview the rendered formula.
- Copy LaTeX, MathML, readable plain text, or a formula image.
- Export editable Word documents using Office Math (OMML).
- Browse recognition history and reuse saved results.

## Quick start

1. Choose **Screenshot**, **Paste Image**, or **Open Image** in the workspace.
2. Adjust the crop and image controls if needed.
3. Select the recognition engine and start recognition.
4. Review the formula preview and edit the LaTeX if necessary.
5. Copy the desired format or export an editable DOCX file.

For several images, open **Batch Recognition**, add images, choose the engine, and start the batch. Open any completed item to review or edit that formula.

## Recognition engines

### Local OCR

The RapidLaTeXOCR model weights are bundled with the app. The first local recognition prepares an isolated Python runtime and inference dependencies in FormulaSnap-managed storage; an Internet connection is required for this setup. Python, Conda, or Anaconda do not need to be installed in advance. After setup, local OCR can run offline.

### Vision API

Configure an API service and save its key in Settings. FormulaSnap stores API keys in the operating system credential store. When using an API, the formula image is sent to that provider and handled under its service and privacy terms.

### Codex CLI

Install and sign in to the official Codex CLI, then select it in FormulaSnap. The app uses the CLI's public commands and does not read or copy its credentials. The CLI runs on the computer, while formula recognition is processed by Codex cloud services; this option is not offline.

## Copying and exporting

The result panel provides LaTeX, MathML, Word formula, and plain-text views. Copy supported formats to the clipboard, copy the rendered formula as a PNG, or export an editable DOCX document.

Plain-text and Word conversion support a documented LaTeX subset. If a command or environment cannot be converted, FormulaSnap reports the limitation and keeps the LaTeX source available for editing. See [Formula format support](docs/FORMATS.md).

## Privacy and data

- API keys are stored in the operating system credential store, not in the source repository or ordinary preferences.
- Local OCR runs on the device after its one-time environment setup.
- Vision API and Codex CLI recognition send formula images to their respective online services.
- FormulaSnap does not copy Codex CLI authentication tokens. See [Models and recognition providers](docs/MODELS.md).

## Project files

The repository is organized so the app, public project information, and local-only data are easy to distinguish. See [Project structure](docs/PROJECT_STRUCTURE.md).

| Path | Purpose |
| --- | --- |
| `app/` | Complete Tauri, React, TypeScript, and Rust application source, lockfiles, tests, icons, and bundled OCR model resources. |
| `docs/` | Public building, format-support, provider, project-structure, and testing guides. |
| `test-data/` | A synthetic formula image for manual smoke checks; no user images are included. |
| `CHANGELOG.md` | User-visible release history. |
| `ARCHITECTURE.md` | Overview of the application design and data flow. |

The Windows installer is distributed as a GitHub Release asset instead of being duplicated in the source tree. Runtime data, build output, dependency folders, API credentials, databases, private screenshots, and local caches are excluded from the public source snapshot.

## Build from source

See [Build from source](docs/BUILDING.md) for Windows prerequisites and commands. The project does not require a preinstalled Python environment to build or use the desktop app.

## Licensing

The FormulaSnap source is published for inspection, but the project does not currently grant an open-source license for the FormulaSnap code. Third-party components retain their own terms. The bundled RapidLaTeXOCR model is MIT-licensed; its attribution and license are included beside the model files in `app/src-tauri/resources/ocr-model/`.
