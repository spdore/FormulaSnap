# FormulaSnap

**Turn formula screenshots into editable mathematics.**

FormulaSnap is a Windows desktop app that recognizes equations from screenshots and images. Capture a screen region, paste or open an image, review the result, then copy or export the formula in the format you need.

[Browse Windows releases](https://github.com/spdore/FormulaSnap/releases)

## What you can do

- Capture a formula from the screen, paste it from the clipboard, or open a PNG, JPG, or WebP image.
- Crop and adjust an image before recognition.
- Choose local OCR, a vision API, or Codex CLI as the recognition engine.
- Process multiple images in a batch and revisit completed results later.
- Edit the recognized LaTeX and preview it as a rendered formula.
- Copy LaTeX, MathML, readable plain text, or a formula image.
- Export editable Word documents with Word's native math format.

## Install on Windows

1. Open the [Releases page](https://github.com/spdore/FormulaSnap/releases) and download the latest **Windows x64 installer**.
2. Optionally verify the v0.1.8 installer checksum in PowerShell:

   ```powershell
   Get-FileHash .\FormulaSnap_0.1.8_x64-setup.exe -Algorithm SHA256
   ```

   Expected SHA-256: `DD822C56DA12AF866FC95291AF6F4B791D2343CBFDE6343EAEC2E73D85275D09`
3. Run the installer and start FormulaSnap from its Windows shortcut.

The installer is currently unsigned, so Windows may show a publisher warning. Verify that the installer came from this repository before running it.

## Recognize a formula

1. Choose **Screenshot**, **Paste Image**, or **Open Image**.
2. Adjust the crop or image controls if needed.
3. Select a recognition engine in the workspace settings.
4. Start recognition and review the rendered formula and LaTeX.
5. Edit the LaTeX if necessary, then copy or export the result.

For multiple equations, open **Batch Recognition**, add images, choose an engine, and start the batch. Each completed item can be opened for review without running recognition again.

## Recognition engines

### Local OCR

The RapidLaTeXOCR model weights are included with the installer. On first use, FormulaSnap downloads and configures an isolated Python runtime and its inference dependencies inside FormulaSnap-managed storage. An Internet connection is required for this one-time setup. After setup, local formula recognition can run offline.

### Vision API

Choose a configured API service and save its API key in Settings. Keys are stored in the operating system credential store. Images sent to an API are processed according to that provider's service and privacy terms.

### Codex CLI

Install and sign in to the official Codex CLI, then select it in FormulaSnap. FormulaSnap uses the CLI's public commands and does not read or copy its login credentials. Requests run through Codex cloud services, so this option is not offline.

## Copying and exporting

Use the result panel to switch between LaTeX, MathML, Word formula, and plain text. Copy supported formats to the clipboard, copy the rendered equation as a PNG, or export an editable DOCX document.

Formula-to-text and Word conversion support a defined LaTeX subset. If a command or environment cannot be converted, FormulaSnap reports the limitation and keeps the LaTeX source available for editing.

## Privacy

- API keys are stored in the operating system credential store and are not included in the installer or source repository.
- Local OCR runs on your device after its first-time environment setup.
- Vision API and Codex CLI recognition send image content to their respective online services.
- FormulaSnap does not copy Codex CLI authentication tokens.

## Source and third-party notices

The source code is publicly available for inspection. No open-source license is currently granted for FormulaSnap itself. Third-party components and the bundled OCR model retain their own licenses; see the notices in the source tree.
