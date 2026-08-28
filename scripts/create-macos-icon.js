const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'darwin') {
  throw new Error('The macOS icon must be generated on the Mac with sips and iconutil.');
}

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'build', 'axiom-icon.png');
const output = path.join(root, 'build', 'axiom.icns');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-icon-'));
const iconset = path.join(temporary, 'axiom.iconset');
fs.mkdirSync(iconset);

for (const size of [16, 32, 128, 256, 512]) {
  execFileSync('/usr/bin/sips', ['-z', String(size), String(size), source, '--out', path.join(iconset, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
  const retina = size * 2;
  execFileSync('/usr/bin/sips', ['-z', String(retina), String(retina), source, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
}

execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', output], { stdio: 'inherit' });
fs.rmSync(temporary, { recursive: true, force: true });
console.log(`Created ${output}`);
