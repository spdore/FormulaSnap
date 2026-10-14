# Release Handoff

## Release 0.1.8

Built on 2026-10-14 for Windows x64. The release includes the three-column FormulaSnap desktop UI, local RapidLaTeXOCR setup, API and Codex CLI recognition providers, batch engine selection, history-linked result editing, and LaTeX conversion to plain text and editable OMML.

### Artifacts

| Artifact | Repository-relative path | Size | SHA-256 |
| --- | --- | ---: | --- |
| GUI executable | .toolchain/cargo-target-0.1.8-hat-accent/release/formulasnap.exe | 18,574,336 bytes | EDA858BCF3F4133032A94A334B0AD2CC022C24E05CA3C438A66683DFAC40680B |
| NSIS installer | .toolchain/cargo-target-0.1.8-hat-accent/release/bundle/nsis/FormulaSnap_0.1.8_x64-setup.exe | 148,160,521 bytes | DD822C56DA12AF866FC95291AF6F4B791D2343CBFDE6343EAEC2E73D85275D09 |

The release executable uses the Windows GUI subsystem. The installer is unsigned.

### Automated verification

- Frontend tests: 30 passed across 5 files.
- Oxlint: passed.
- TypeScript/Vite production build: passed. Vite reports that the main JavaScript chunk exceeds 500 kB.
- Rust offline tests: 21 passed, 0 failed, 2 ignored because those tests require live provider credentials.
- The LaTeX conversion suite covers mathcal, hat accents, aligned, arrays, matrices, cases, nested structures, unsupported commands, and DOCX XML packaging.

### Manual verification limits

The 0.1.8 release was not launched for this handoff. Microsoft Word was not used to open the generated DOCX. The following require user or environment testing:

- Install and upgrade behavior, Start Menu shortcuts, and uninstallation.
- First-time local environment setup in a fresh isolated data directory and real CPU/GPU inference.
- DeepSeek requests with a user's valid API key and Codex CLI requests under the user's signed-in account.
- Clipboard PNG paste into target applications and native window/menu behavior.
- Microsoft Word repair prompts, equation layout, and editing.

### Repository hygiene

The public source snapshot excludes .runtime, .toolchain, application databases, WebView2 profiles, test screenshots, build output, dependency directories, API credentials, and local provider logs. The synthetic Gaussian-integral fixture and MIT-licensed model resources are included.
