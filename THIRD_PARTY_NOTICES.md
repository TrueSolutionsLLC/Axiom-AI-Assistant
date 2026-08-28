# Third-party notices

Project Axiom includes open-source dependencies distributed under their respective licenses. Production release preparation must retain the full license texts shipped by those packages.

## MediaPipe Tasks Vision and Face Landmarker

- Copyright Google LLC and contributors.
- License: Apache License 2.0.
- Source: https://github.com/google-ai-edge/mediapipe
- Web package documentation: https://github.com/google-ai-edge/mediapipe/tree/master/mediapipe/tasks/web/vision
- Face Mesh model card: https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf
- Blendshape model card: https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf

The bundled face model runs on-device. Axiom does not upload camera frames to the OpenAI API.

## ScatteringSkull

- Model by Vladimir Petkovic / Adobe Inc., 2025.
- License: Creative Commons Zero 1.0 Universal (CC0).
- Source: https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/ScatteringSkull
- Asset copyright metadata: “2025 (c) Adobe Inc., model by Vladimir Petkovic, CC0 1.0 Universal.”

## Three.js

- Copyright 2010–2026 Three.js authors.
- License: MIT.
- Source: https://github.com/mrdoob/three.js

## WavLM (speaker identity)

- Model: `microsoft/wavlm-base-plus-sv`.
- Source: https://huggingface.co/microsoft/wavlm-base-plus-sv
- License: not yet independently confirmed against Microsoft's actual model card/license file — verify before a commercial release, do not assume MIT by analogy with the runtime packages below.
- The bundled model runs entirely on-device; no audio is uploaded for voice recognition.

## all-MiniLM-L6-v2 (local memory embeddings)

- Model: `Xenova/all-MiniLM-L6-v2` (an ONNX port of `sentence-transformers/all-MiniLM-L6-v2`).
- Source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
- License: Apache License 2.0.
- Runs entirely on-device for semantic memory search; no memory text is sent anywhere to generate an embedding.

## Runtime npm dependencies actually shipped in the packaged app

The packages below are real runtime dependencies (not build-time-only) as of the current `package.json` — each resolves to a permissive license per its own npm registry entry, but this list is a starting point for the independent audit `CLEAN_ROOM.md` requires before a commercial release, not a substitute for it.

- Electron — MIT
- React — MIT
- Three.js — MIT (see above)
- `@huggingface/transformers` — Apache-2.0
- `onnxruntime-node` — MIT
- `ws` — MIT
- `systeminformation` — MIT
