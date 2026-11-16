// Renders assets/logo.svg to a TRANSPARENT 2048px PNG (macOS icon margin included). qlmanage paints white, do not use it.
// Run: node_modules/electron/dist/Electron.app/Contents/MacOS/Electron tools/render-mac-icon.js assets/logo.svg /tmp/icon.png
// then sips to 1024 (assets/logo-mac-1024.png) and sips + iconutil into assets/logo.icns, then zsh build-mac-app.sh.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const [svgPath, outPath] = process.argv.slice(-2);
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const svg = fs.readFileSync(svgPath, 'utf8')
    .replace(/viewBox="0 0 256 256"/, 'viewBox="-25 -25 306 306" width="1024" height="1024"');
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false,
    backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(1);
  let done = false;
  win.webContents.on('paint', (_e, _dirty, img) => {
    if (done) return; const s = img.getSize(); if (s.width < 1024) return;
    done = true; fs.writeFileSync(outPath, img.toPNG()); console.log('wrote', s); app.quit();
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  setTimeout(() => { if (!done) { console.log('timeout'); app.quit(); } }, 8000);
});
