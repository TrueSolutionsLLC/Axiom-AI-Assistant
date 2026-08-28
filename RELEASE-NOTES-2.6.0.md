# Axiom 2.6.0 — Hardware Sensor Fabric

This release gives Axiom a cross-platform, privacy-bounded view of the computer it inhabits. The same verified snapshot powers both the visual diagnostics console and spoken answers about the machine.

## Live computer vitals

- CPU model, physical/logical core topology, aggregate load, user/system load, clock, per-core activity, uptime, and CPU temperature when the operating system or hardware driver exposes it.
- GPU inventory, utilization, VRAM capacity and use, temperature, fan speed, power draw, and driver version where supported. NVIDIA driver telemetry has a direct native fallback on Windows.
- Physical memory, available memory, swap use, mounted volume capacity, storage utilization, disk throughput/IOPS where exposed, and top processes by CPU and memory pressure.
- Active network-interface identity, IP address, link speed, receive/transmit throughput, battery charge, AC state, remaining time, cycles, and estimated health.
- Hardware identity includes model, manufacturer, OS, release, architecture, and virtualization state. Serial numbers, UUIDs, MAC addresses, process command lines, and credentials are intentionally excluded.

## Interface

- New `COMPUTER VITALS` console inside CORE with six primary readouts and detailed processor, graphics, storage, network/power, and process decks.
- The compact right-side `VITAL ARRAY` now displays live CPU, memory, CPU thermal, and GPU load and opens the full console when selected.
- Slow driver-backed inventory refreshes in the background while native CPU and memory counters continue at low latency.
- Missing sensors say `NOT EXPOSED`; Axiom never fabricates a temperature, fan, battery, or utilization value.

## Conversation

- Requests involving CPU, GPU, RAM, storage, network, battery, thermals, fans, utilization, uptime, or processes route to a local verified diagnostics tool.
- Computer-temperature questions no longer trigger an unrelated web/weather search.
- Axiom can summarize or speak the current readings naturally through the selected voice provider.

## Verification

- 21 automated test files / 104 tests passing.
- Main-process TypeScript and production renderer builds passing.
- Full visual QA passing: all 9 modules, the six-readout hardware deck, five detailed hardware cards, Runtime permission kernel, settings, memory, mission control, global intelligence, layout overflow, and renderer errors.
- Live Windows probe verified the installed Ryzen CPU topology, NVIDIA GPU load/VRAM/temperature/fan/power, both mounted storage volumes, active Wi-Fi adapter, memory/swap, uptime, and process inventory.

Sensor availability remains hardware- and driver-dependent. In particular, standard Windows and macOS APIs do not expose CPU temperature on every machine; Axiom reports that limitation explicitly instead of estimating it.
