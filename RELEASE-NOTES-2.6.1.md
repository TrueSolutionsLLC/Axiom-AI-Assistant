# Axiom 2.6.1 — Vital Reactor

This release makes live computer health part of Axiom's normal presence. The user no longer has to ask for system statistics before seeing the state of the machine.

## Always-on hardware visualization

- Replaces the small text-only Vital Array with an animated `VITAL REACTOR` in the right-side command spine.
- Three concentric instrument rings visualize CPU, memory, and GPU load independently.
- Four rolling traces show CPU, GPU, RAM, and network activity over time.
- Compact sensors expose CPU temperature, GPU temperature, primary-storage pressure, and live receive/transmit traffic.
- The reactor changes from cyan `NOMINAL` to amber `HIGH LOAD` or red `THERMAL ALERT` using measured load and temperature thresholds.
- Selecting the reactor opens the full Runtime + Hardware Core diagnostics console.
- Sensors that the operating system or hardware does not expose display an explicit dash rather than an invented reading.

## Verification

- 21 automated test files / 104 tests passing.
- Production main-process and renderer builds passing.
- Visual release gate verifies all three rings, four traces, four sensor tiles, and the diagnostics click-through in addition to the existing complete interface audit.

