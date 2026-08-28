# Asset and dependency provenance

| Item | Origin | License/status | Notes |
|---|---|---|---|
| Application source | Newly authored for Project Axiom | Proprietary, owner-controlled | Clean-room implementation |
| Skull HUD animation, tracking, eyes and waveform | Newly authored Axiom TypeScript/CSS | Original | Clean-room controller; no purchased-assistant source copied |
| Commissioned reference screen and skull mouth poses (removed) | Robbie's commissioned modification set | Removed from the shipped app 2026-08-28 | The exact reference background and three recovered PNG poses (`skull-closed/half/open.png`, `reference-screen.png`) had zero code references — the active skull avatar (`ModdedSkullAvatar.tsx`) uses the separate, newly-authored `axiom-skull-*.png` set below — but were still being bundled into every packaged build via Vite's public-directory copy. Deleted ahead of public distribution rather than left as unresolved legal exposure with no runtime purpose. |
| Axiom skull mouth poses (`axiom-skull-closed/half/open.png`) | Newly authored for Project Axiom | Original | The actively-used mouth-pose set referenced by `ModdedSkullAvatar.tsx`; distinct files from the removed commissioned set above (different dimensions/content, not a rename) |
| MediaPipe Pose Landmarker model | Official Google MediaPipe model bundle | Apache-2.0 | Licensed modern equivalent of the old mod's full-person tracking fallback |
| MediaPipe Tasks Vision | `@mediapipe/tasks-vision` npm package from Google | Apache-2.0 | Locally bundled; no camera frames leave the renderer |
| MediaPipe Face Landmarker model | Official Google MediaPipe model bundle | Apache-2.0 | 478-point face model; see Google model card and `THIRD_PARTY_NOTICES.md` |
| ScatteringSkull anatomical model | Khronos glTF Sample Assets; model by Vladimir Petkovic / Adobe | CC0 1.0 Universal | Adapted at runtime into neon wireframe and articulated upper/lower groups |
| Three.js | npm package | MIT | WebGL rendering for the anatomical skull and HUD scene |
| UI icons | CSS/text primitives in milestone 1 | Original | Replace with an audited icon set if needed |
| React | npm package | MIT | Verify notices before release |
| Electron | npm package | MIT | Verify notices before release |
| Vite | npm package | MIT | Build-time dependency |
| Playwright | npm package | Apache-2.0 | Development/visual QA only; excluded from packaged application |

No purchased-assistant assets are authorized for this project.
# Commissioned Jarvis modification assets

The three `src/renderer/public/mod-assets/skull-*.png` mouth-pose renders were recovered from Robbie's existing commissioned modification set on 2026-08-14 at his explicit request. They are treated as user-supplied project assets and are not sourced from the purchased application's original code. Confirm distribution rights for these images before public or commercial release.
