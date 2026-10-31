// Renders the app icon, tray icons and drag image from SVG.
// Run with `npm run icons` after changing the artwork.
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';

const render = (svg, width, out) => {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
  fs.writeFileSync(out, png);
};

// App icon on the macOS grid: 824px rounded square inside a 1024 canvas.
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5b82ff"/>
      <stop offset="1" stop-color="#2f4fd6"/>
    </linearGradient>
    <linearGradient id="plank" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e7b876"/>
      <stop offset="1" stop-color="#c08a45"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#0b1a5c" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
  <g filter="url(#shadow)">
    <path d="M300 300h150l70 70v230H300z" fill="#ffffff"/>
    <path d="M450 300v70h70z" fill="#d7e0ff"/>
    <rect x="340" y="420" width="130" height="18" rx="9" fill="#c9d4ff"/>
    <rect x="340" y="464" width="100" height="18" rx="9" fill="#c9d4ff"/>
    <rect x="560" y="420" width="180" height="180" rx="28" fill="#ffcf5c"/>
    <rect x="560" y="490" width="180" height="22" fill="#f2b53a"/>
    <rect x="240" y="600" width="544" height="56" rx="22" fill="url(#plank)"/>
    <rect x="300" y="650" width="44" height="110" rx="14" fill="#b07a38"/>
    <rect x="680" y="650" width="44" height="110" rx="14" fill="#b07a38"/>
  </g>
</svg>`;

// Menu bar template icon: black shapes on transparent, macOS tints it.
const trayTemplate = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <path d="M2.5 2.5h4l1.5 1.5v5.5H2.5z" fill="#000"/>
  <rect x="9" y="5" width="4.5" height="4.5" rx="1" fill="#000"/>
  <rect x="1" y="10.25" width="14" height="1.75" rx="0.6" fill="#000"/>
  <rect x="2.5" y="12" width="1.5" height="2.5" rx="0.5" fill="#000"/>
  <rect x="12" y="12" width="1.5" height="2.5" rx="0.5" fill="#000"/>
</svg>`;

const dragImage = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <path d="M10 4h20l8 8v32H10z" fill="#ffffff" stroke="#3a63e8" stroke-width="2"/>
  <path d="M30 4v8h8" fill="none" stroke="#3a63e8" stroke-width="2"/>
</svg>`;

render(appIcon, 1024, 'build/icon.png');
render(appIcon, 256, 'assets/icon-256.png');
render(appIcon, 32, 'assets/tray-win.png');
render(trayTemplate, 16, 'assets/trayTemplate.png');
render(trayTemplate, 32, 'assets/trayTemplate@2x.png');
render(dragImage, 48, 'assets/drag.png');
// Home-screen and favicon images for the phone page, drawn edge to edge
// (iOS rounds the corners itself).
const webIcon = fs.readFileSync('src/web/icon.svg', 'utf8');
render(webIcon, 180, 'src/web/icon-180.png');
render(webIcon, 512, 'src/web/icon-512.png');
console.log('icons written');
