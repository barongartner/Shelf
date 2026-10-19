// Dev aid: runs two copies of Shelf on this computer ("a" and "b") on the
// same shelf, so you can watch items move between them.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const appData = path.join(os.homedir(), 'Library', 'Application Support');
const code = 'TEST-TEST-TEST';
for (const p of ['a', 'b']) {
  const dir = path.join(process.platform === 'darwin' ? appData : process.env.APPDATA, `Shelf-${p}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  s.id = s.id || crypto.randomBytes(8).toString('hex');
  s.code = code;
  s.name = p === 'a' ? 'Mac (a)' : 'PC (b)';
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
}
const electron = require('electron');
for (const p of ['a', 'b']) {
  spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, SHELF_PROFILE: p } });
}
