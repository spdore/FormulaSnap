# Testing and Acceptance

## Automated checks

From the repository root, run:

```powershell
Push-Location app
npm test
npm run lint
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
Pop-Location
```

The frontend suite covers formula conversion, preview, image processing, batch routing, and recognition-service configuration. Rust tests cover API request construction, local runtime behavior, Codex CLI handling, and platform helpers. Provider tests that require a live API credential or signed-in CLI account may be skipped when those credentials are unavailable.

## Manual smoke checks

The public fixture [test-data/gaussian-integral.png](../test-data/gaussian-integral.png) is a synthetic formula image, not a user's screenshot. Use it for a basic smoke check.

1. Install the Windows x64 release and launch it from its Windows shortcut.
2. Open, paste, or capture a formula image; adjust the crop and run recognition.
3. Review and edit LaTeX, then copy LaTeX, MathML, plain text, and the rendered formula image.
4. Export an editable DOCX and open it in Microsoft Word. Check for repair prompts and edit fractions, scripts, and multiline expressions.
5. Add multiple images to Batch Recognition. Check engine selection, progress, cancel, retry, result viewing, and history association.
6. Select local OCR. On a fresh install, complete the one-time runtime setup and recognize the fixture; then disconnect the network and check local inference again.
7. If testing an API or Codex CLI provider, use your own credentials. Confirm provider errors are visible and credentials do not appear in logs or repository files.
8. Paste a copied formula PNG into a target application, including while offline after local setup.
9. Check menus, keyboard navigation, confirmations, progress feedback, and background-process window behavior.

Live API and Codex requests require an account and network access. First-time local setup requires downloading runtime dependencies. Automated tests do not establish that every provider, installer, GPU, or Microsoft Word version has been manually verified.
