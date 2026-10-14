# FormulaSnap Frontend

This directory contains the React, TypeScript, and Vite frontend for the FormulaSnap desktop application. Product details, workspace setup, build commands, architecture, and release verification are documented in the repository-root README.md.

To start the frontend development server from the repository root:

~~~powershell
Push-Location frontend
npm --cache $env:npm_config_cache run dev
Pop-Location
~~~

UI source is in src. The Tauri desktop application and Rust integration are in src-tauri.