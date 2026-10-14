# Models and Recognition Providers

## Bundled formula model

The installer includes the official RapidAI RapidLaTeXOCR v0.0.0 ONNX model files. First-time local setup copies them into FormulaSnap-managed runtime storage and verifies each file's size and SHA-256. The weights do not need to be downloaded separately.

Source: [RapidAI/RapidLaTeXOCR](https://github.com/RapidAI/RapidLaTeXOCR)

Release: [v0.0.0](https://github.com/RapidAI/RapidLaTeXOCR/releases/tag/v0.0.0)

License: MIT. See the included [model attribution](../app/src-tauri/resources/ocr-model/MODEL-ATTRIBUTION.md) and [license](../app/src-tauri/resources/ocr-model/LICENSE).

| File | Size in bytes | SHA-256 |
| --- | ---: | --- |
| image_resizer.onnx | 38,967,751 | E0B075C39700F64D50400F39C8FC186BBB3B5D84D31864008313F376603ACA9D |
| encoder.onnx | 89,008,136 | 01BF5DC25539CA0CD5B1BD29296EA495977A6BA5F629DC4178277809D26E5E7D |
| decoder.onnx | 50,952,726 | BD695497BF1B22279B7626F5916C79226E1E244C84355F8DA7EDFD2D921D0072 |
| tokenizer.json | 24,174 | 1DC27B18D6A518D0D5FF3F4BB7BD98521FE80AD39E5B2A246D4109F1BB9D5019 |

The model bundle totals 178,952,787 bytes (about 170.66 MiB). FormulaSnap marks a model directory as app-owned only after verifying the complete file set and hashes. It does not replace or delete incomplete directories that lack the FormulaSnap ownership marker.

## First local recognition

A new installation defaults to local recognition. The user can choose “Configure local recognition” in Settings; Python, Anaconda, or Miniconda do not need to be installed beforehand, and no terminal is required. First-time setup requires an Internet connection to obtain the pinned runtime and Python dependencies. Once setup succeeds, subsequent local inference can run offline.

- Windows x64 uses the pinned Miniforge 26.7.2-0 release installer, Miniforge3-26.7.2-0-Windows-x86_64.exe. Its expected size is 148,256,480 bytes and its SHA-256 is 71CF9519087BE74FA53021219FF292BEB2FC05FA49E0BB6EB0E0B6B14FCCBAAB. Source: [conda-forge Miniforge 26.7.2-0](https://github.com/conda-forge/miniforge/releases/tag/26.7.2-0).
- The installer uses JustMe mode, does not register a system Python or modify PATH, and runs with /S and /Q. CONDA_NO_PLUGINS=true is used for Conda commands only, not for the constructor installer.
- Windows paths are normalized before use. A SUBST alias is created only when an installer path genuinely needs one due to spaces, non-ASCII characters, or length, and is released after use when safe.
- The managed environment uses Python 3.10, RapidLaTeXOCR 0.0.9, and ONNX Runtime 1.23.2. CPU and CUDA environments are isolated separately. Conda and pip packages, temporary files, HOME, configuration, and caches stay under the FormulaSnap runtime root.
- A FormulaSnap-owned existing Conda environment is reused at its original location because its absolute prefix cannot be moved safely. When a user changes the model storage location, only verified model files are copied; existing runtimes are not deleted.
- Windows checks the available NVIDIA driver and validates CUDA with a real image inference. CUDA is reported as ready only when the worker identifies CUDAExecutionProvider and the smoke test succeeds. If CUDA setup or inference fails, FormulaSnap removes only its marked CUDA environment and falls back to CPU. Without a usable NVIDIA driver, only the CPU environment is created.
- The app determines whether to prefer configured Tsinghua or Aliyun HTTPS package mirrors using the Windows GeoID. A stalled download can fail over after 45 seconds without data. Miniforge and the bundled model still use pinned, hash-verified official resources. If all candidates fail, the app keeps an error with a retry option and asks the user to check the network.
- Download percentages represent actual byte counts when a content length is known. Extraction and dependency setup display their current stage without fabricated percentages or ETAs. Installer failures preserve exit status, stdout/stderr diagnostics, and the installer step log when available.
- The bundled smoke-test image is the synthetic Gaussian integral in test-data/gaussian-integral.png. Historical CPU verification of this fixture does not imply broad accuracy across formula types or image quality.

For installed builds, app-owned models, runtimes, caches, and diagnostics live in FormulaSnapData beside the release executable. See [Testing and acceptance](TESTING.md) for manual smoke checks and environment-dependent limitations.

## Codex CLI

FormulaSnap provides a Codex CLI recognition engine alongside API and local OCR providers. It discovers codex.exe through PATH or a user-selected executable. The public codex login status command distinguishes an unavailable CLI, a signed-out CLI, a failed status check, and a signed-in account.

Each task writes the processed image, JSON Schema, final-response file, and CLI log configuration into a FormulaSnap-managed task directory. The app invokes codex exec with JSON output, an ephemeral session, the actual image file through --image, a read-only sandbox, and a structured final response. MCP servers and plugins are disabled. FormulaSnap accepts only successful completion whose final response matches the required LaTeX schema. It does not treat reasoning text or tool output as formula content.

Windows background CLI processes run without a visible console. Standard output and error streams are consumed asynchronously. Cancellation and exit cleanup apply only to CLI processes started by FormulaSnap.

Codex CLI runs on the user's computer, but formula images are processed by Codex cloud services; this is not offline recognition. The CLI manages its own authentication. FormulaSnap does not read auth.json, copy tokens, or inspect process memory. To locate an existing login, the CLI may manage a short-lived tmp/arg0 alias under the user's existing CODEX_HOME. FormulaSnap does not redirect or clean up that CLI-owned directory.

Official references: [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [CLI developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli), and [authentication](https://learn.chatgpt.com/docs/auth).

## DeepSeek vision API

The built-in DeepSeek adapter follows the official [Vision guide](https://api-docs.deepseek.com/guides/vision/) and [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/):

- Sends a POST request to https://api.deepseek.com/chat/completions using the deepseek-flash model.
- Sends the image as a Base64 data URL in the user message content array with type image_url. The system message contains only the formula-transcription policy.
- Disables thinking mode, uses temperature 0, and sets max_tokens to 8192.
- Supports JPEG, PNG, GIF, and WebP images. Base64 images are limited to 32 MiB and JSON request bodies to 48 MiB.
- Reports HTTP errors and token truncation, then extracts the transcription from choices[0].message.content.
- Stores the API key only in the operating-system credential store. Ordinary preferences retain the service ID, mode, output format, image settings, and most recent real image-request result. A legacy visionVerified=false value does not block recognition, and the app sends no test image on startup or when saving settings.

Other OCR projects may be evaluated in the future; they are not integrated or benchmarked against a shared dataset. Each bundled model and runtime remains subject to its upstream distribution terms. Dependency license notices should be reviewed before redistribution.
