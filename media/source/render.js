'use strict';

// Renders every board in Media.html to media/<Name>.png at 2x.
// Run from the repo root: npx electron media/source/render.js
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const BOARDS = {
  banner: 'Banner',
  hero: 'Hero',
  social: 'Social Preview',
  batch: 'Batch Save',
  setup: 'Setup',
  desktop: 'Desktop',
  network: 'How It Moves',
};

app.commandLine.appendSwitch('force-device-scale-factor', '2');
app.commandLine.appendSwitch('high-dpi-support', '1');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 900, useContentSize: true, webPreferences: { offscreen: false } });
  await win.loadFile(path.join(__dirname, 'Media.html'));
  // Fonts and images first, so nothing renders in a fallback face.
  await win.webContents.executeJavaScript(
    'Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))]).then(() => 1)',
  );
  const out = path.join(__dirname, '..');
  for (const [id, name] of Object.entries(BOARDS)) {
    // Each board alone at the top left, window sized to it.
    const r = await win.webContents.executeJavaScript(`(() => {
      document.body.style.padding = '0';
      for (const s of document.querySelectorAll('.board')) s.style.display = s.id === ${JSON.stringify(id)} ? '' : 'none';
      const b = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
      return { width: Math.ceil(b.width), height: Math.ceil(b.height) };
    })()`);
    win.setContentSize(r.width, r.height);
    await new Promise((res) => setTimeout(res, 400));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: r.width, height: r.height });
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
    const s = img.getSize();
    console.log(`${name}.png ${s.width}x${s.height}`);
  }
  app.quit();
});
