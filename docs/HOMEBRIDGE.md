# Axiom Homebridge setup

Axiom controls smart-home devices through **Homebridge** (specifically its Config UI X web interface), not Home Assistant — Home Assistant support was removed; Homebridge is the only supported smart-home platform.

## Connect

1. Homebridge must be running in **Insecure Mode** — Homebridge Settings → Insecure Mode, or start it with the `-I` flag. This is what Homebridge's own accessory-control API requires; Axiom can't control anything without it.
2. In Axiom, open **Settings → Connected Services → Homebridge Config UI X**.
3. Enter the Homebridge UI's URL and the username/password you sign in with there. Axiom logs in itself and caches the session — it doesn't need a separate API token.
4. Save and Connect.

## What becomes available

- Reading the live state of every accessory Homebridge knows about (lights, locks, thermostats, garage doors, sensors, alarms — anything exposed to Homebridge).
- Spoken/typed control of those same accessories.
- Verification after control: Axiom reads the resulting accessory state back from Homebridge before claiming an action succeeded, rather than assuming a command worked.

## Safety boundaries

Turning an ordinary device on or off can run directly once the capability is enabled. Unlocking a lock, opening a garage or secured entry, or disarming a security system requires an explicit, fresh approval from you first — a request like "lock the front door" is treated differently from "unlock the front door" for exactly this reason.

## Not currently supported

Axiom does not currently do continuous background monitoring of Homebridge accessory state (no push alerts when a door opens while you're away) — checking state is on-demand, when you ask. This was a Home Assistant-specific capability that doesn't have a Homebridge equivalent yet.
