import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootstrap, macScriptPrelude } from './macAutomation';

const source = fs.readFileSync(path.join(process.cwd(), 'src/main/macAutomation.ts'), 'utf8');

// This file cannot run JXA from Windows CI, so it pins the invariants that
// would otherwise only surface on the target Mac.
describe('macOS automation scripts', () => {
  it('reaches delay through StandardAdditions rather than a JXA global', () => {
    expect(macScriptPrelude).toContain('includeStandardAdditions=true');
    expect(macScriptPrelude).toMatch(/const delay\s*=/);
  });

  it('defines delay in the script every UI action actually composes', () => {
    // Asserting the composed output, not just the prelude constant: the bug
    // was that bootstrap() was reached but shipped no delay definition.
    expect(bootstrap('Notes')).toMatch(/const delay\s*=/);
    expect(bootstrap('Notes')).toContain('includeStandardAdditions=true');
  });

  it('never emits delay() into a script that lacks the prelude', () => {
    const functions = source.split(/export async function /).slice(1);
    const offenders = functions
      .filter((body) => /delay\(\d/.test(body))
      .filter((body) => !body.includes('bootstrap(') && !body.includes('macScriptPrelude'))
      .map((body) => body.slice(0, body.indexOf('(')));
    expect(offenders).toEqual([]);
  });

  it('ships the Apple Events entitlement its usage description depends on', () => {
    const entitlements = fs.readFileSync(path.join(process.cwd(), 'build/entitlements.mac.plist'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const extendInfo = pkg.build?.mac?.extendInfo ?? {};
    if (pkg.build?.mac?.hardenedRuntime && extendInfo.NSAppleEventsUsageDescription) {
      expect(entitlements).toContain('com.apple.security.automation.apple-events');
    }
    for (const device of ['device.camera', 'device.audio-input']) {
      expect(entitlements).toContain(`com.apple.security.${device}`);
    }
  });

  it('keeps every StandardAdditions caller wired to an application object', () => {
    // getVolumeSettings/setVolume/delay are all osax commands; a bare global
    // call throws "Can't find variable" at runtime on macOS.
    for (const command of ['getVolumeSettings', 'setVolume']) {
      const bare = new RegExp(`(?<![.\\w])${command}\\(`);
      const calls = source.split('\n').filter((line) => bare.test(line));
      expect(calls, `${command} is called without an application receiver`).toEqual([]);
    }
  });
});
