# Project Structure

FormulaSnap keeps its product overview and release history at the repository root, groups the desktop application under `app/`, and separates public guides and synthetic test data. Workstation-specific support material and local runtime data are not part of the published project tree.

```text
FormulaSnap/
  app/
    src/                         React and TypeScript interface
    src-tauri/                   Rust commands, Tauri config, icons, OCR worker
      resources/ocr-model/       Bundled model weights and upstream license
    package.json                 Frontend scripts and dependencies
    package-lock.json            Locked npm dependency versions
  docs/
    BUILDING.md                  Windows build guide
    FORMATS.md                   Supported formula-conversion structures
    MODELS.md                    Model and recognition-provider details
    PROJECT_STRUCTURE.md         Public/local file map
    TESTING.md                   Automated checks and manual smoke guide
  test-data/
    gaussian-integral.png        Synthetic formula smoke-test image
  .gitignore                     Local data and generated-output exclusions
  ARCHITECTURE.md                Application modules and data flow
  CHANGELOG.md                   User-visible release history
  README.md                      Product overview, install, and usage
```

## Keep in the public repository

- Tauri, React, TypeScript, and Rust source; package manifests and lockfiles; icons; tests; and resources required to build the application.
- The OCR model weights bundled with the app. Keep the upstream MIT license and attribution beside those weights.
- Product documentation, release notes, architecture overview, build instructions, model/provider information, and public testing guidance.
- Synthetic formula fixtures made for the project. Do not add private screenshots or formulas copied from application history.

Publish the 148 MB Windows installer as an asset on the [GitHub Releases page](https://github.com/spdore/FormulaSnap/releases). Do not duplicate that generated binary in Git history. The current v0.1.8 checksum is listed in the README.

## Keep local

The root `.gitignore` excludes runtime environments, WebView2 profiles, databases, dependency folders, build output, tool caches, test results, logs, and local credentials. Workspace-only launchers, AI agent instructions, release handoff notes, UI review notes, concept drafts, and private formula images also stay out of public commits.

FormulaSnap itself currently has no open-source license. The bundled model's license does not grant a license to the FormulaSnap application code.
