# Third-party software and model notices

Vocalis application code is distributed under the MIT license in `LICENSE`.
Third-party code and separately downloaded model weights keep their own licenses.
No statement in this project removes those obligations.

## Included code and tools

- **Applio inference/realtime code**: MIT, Copyright (c) 2026 AI Hispano. Original notice: `engine/vendor/LICENSE-APPLIO`. Source: https://github.com/IAHispano/Applio. Local integration and realtime pitch fixes are modifications of this code.
- **Electron and Chromium**: Electron MIT and Chromium third-party notices are supplied with the Electron runtime by electron-builder (`LICENSE.electron.txt`, `LICENSES.chromium.html`). Source: https://github.com/electron/electron.
- **Renderer dependencies** (React, Radix UI, Lucide, fonts and their dependencies): complete installed production-package notices are collected in `app/build/THIRD_PARTY_NOTICES.txt` and copied to the installer's `licenses` directory. Dependency versions are pinned by `app/package-lock.json`.
- **uv 0.13.6**: MIT OR Apache-2.0, Astral Software Inc. The complete upstream texts are included in `app/build/THIRD_PARTY_NOTICES.txt`. Source: https://github.com/astral-sh/uv/tree/0.13.6. The executable is obtained separately during setup and is excluded from Git.

## Runtime dependencies installed on first use

Python, PyTorch, torchaudio, NumPy, SciPy, sounddevice/PortAudio, libsndfile, FAISS, transformers, ONNX Runtime, FastAPI and the remaining packages are downloaded by `uv` from the locked configuration in `engine/uv.lock`. They are not bundled in the source repository or installer. Their distribution files and installed package metadata contain their original license texts. `engine/pyproject.toml` lists direct dependencies; the lockfile includes transitive dependencies.

## Shared RVC assets downloaded on request

The pinned source mirror for ContentVec, its config, RMVPE and FCPE is [IAHispano/Applio](https://huggingface.co/IAHispano/Applio/tree/3ff370b7023086f57e200ef86a9a251ddf4da472), whose model card declares MIT. Per-file source URLs, sizes and available SHA-256 values are in `catalog/voices.json`. These technical assets are not CC0 target voices and are not included in Git or the installer. Upstream projects: [ContentVec](https://github.com/auspicious3000/contentvec), [RMVPE](https://github.com/Dream-High/RMVPE), [FCPE](https://github.com/CNChTu/FCPE).

## Excluded materials

No third-party target-voice weights, indexes, character images or converted voice examples are shipped. No training datasets or microphone recordings are published. User-selected models/audio remain local and are not relicensed by Vocalis. See `MODEL_POLICY.md`.
