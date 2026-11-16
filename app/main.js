// Dojo: main process. Owns the PTYs, discovers hub projects, persists open sessions.
const { app, BrowserWindow, ipcMain, Menu, Notification, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('@lydell/node-pty');

const IS_WIN = process.platform === 'win32';
const STATE_FILE = () => path.join(app.getPath('userData'), 'sessions.json');

// Per-machine config: <userData>/config.json overrides the platform default next to this file
// (config.win.json / config.mac.json). Keys: hub (folder whose subfolders become projects),
// extra (list of {name, path} outside the hub), skip (hub subfolders to hide), categories.
const expand = (p) => (p.startsWith('~') ? path.join(require('os').homedir(), p.slice(1)) : p);
function loadConfig() {
  // COCKPIT_CONFIG: explicit config file (demo hub for screenshots, tests). Never set in normal use.
  const files = [process.env.COCKPIT_CONFIG, path.join(app.getPath('userData'), 'config.json'), path.join(__dirname, IS_WIN ? 'config.win.json' : 'config.mac.json')];
  for (const f of files.filter(Boolean)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} }
  return {};
}
const CONFIG = loadConfig();
// Default hub: ~/Desktop/Claude Code Projects when it exists, else the home folder. config.json "hub" overrides.
const DEFAULT_HUB = path.join(require('os').homedir(), 'Desktop', 'Claude Code Projects');
const HUB = expand(process.env.COCKPIT_HUB || CONFIG.hub || (fs.existsSync(DEFAULT_HUB) ? DEFAULT_HUB : '~'));

let win;
const ptys = new Map(); // id -> pty

// Exact status from Claude Code hooks. tools/dojo-hook.sh (registered in ~/.claude/settings.json) posts every
// SessionStart, UserPromptSubmit, PostToolUse, Stop and Notification here, tagged with the tab id from
// COCKPIT_SESSION. Localhost only, plus a per-launch token so no other local process can fake a status.
const HOOK_TOKEN = require('crypto').randomBytes(16).toString('hex');
let HOOK_PORT = 0;
const HOOK_FIELDS = ['session_id', 'source', 'notification_type', 'message', 'tool_name'];
const hookServer = require('http').createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on('end', () => {
    res.end('ok');
    if (req.headers['x-dojo-token'] !== HOOK_TOKEN) return;
    const u = new URL(req.url, 'http://127.0.0.1');
    const tab = u.searchParams.get('tab');
    if (!tab || !ptys.has(tab) || !win || win.isDestroyed()) return;
    let raw = {};
    try { raw = JSON.parse(body || '{}'); } catch {}
    const data = {};
    for (const k of HOOK_FIELDS) if (raw[k] != null) data[k] = String(raw[k]).slice(0, 300);
    if (typeof raw.prompt === 'string') data.prompt = raw.prompt.slice(0, 300);
    win.webContents.send('hook:event', { tab, event: u.pathname.slice(1), data });
  });
});
hookServer.listen(0, '127.0.0.1', () => { HOOK_PORT = hookServer.address().port; });

function discoverProjects() {
  // Same lookup as Claude Code: the folder itself, every parent folder, and the global ~/.claude/CLAUDE.md.
  // Without the last two, projects that inherit the brain showed "no brain".
  const home = require('os').homedir();
  const globalBrain = fs.existsSync(path.join(home, '.claude', 'CLAUDE.md'));
  const brain = (p) => {
    if (globalBrain) return true;
    for (let d = p; ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, 'CLAUDE.md'))) return true;
      if (path.dirname(d) === d) return false;
    }
  };
  const out = [{ name: 'Hub', path: HUB, brain: brain(HUB), isHub: true }];
  const skip = new Set(CONFIG.skip || []);
  let entries = [];
  try { entries = fs.readdirSync(HUB, { withFileTypes: true }); } catch {}
  for (const d of entries) {
    if (!d.isDirectory() || d.name.startsWith('_') || d.name.startsWith('.') || skip.has(d.name)) continue;
    const p = path.join(HUB, d.name);
    out.push({ name: d.name, path: p, brain: brain(p) });
  }
  for (const x of CONFIG.extra || []) {
    const p = expand(x.path);
    if (fs.existsSync(p) && !out.some((o) => o.path === p)) out.push({ name: x.name, path: p, brain: brain(p) });
  }
  return out;
}

// Claude Code stores conversations in ~/.claude/projects/<path with every non-alphanumeric char as '-'>.
const convFolder = (dir) => path.join(app.getPath('home'), '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
function conversations(dir) {
  try {
    return fs.readdirSync(convFolder(dir)).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ id: f.slice(0, -6), mtime: fs.statSync(path.join(convFolder(dir), f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}
function hasHistory(dir) { return conversations(dir).length > 0; }

// No shared auto-memory linking any more (Balazs 2026-11-11): auto-memory is retired, every rule lives in the
// brain and the project CLAUDE.md files, which Claude Code loads from the start folder and its parents anyway.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Which `claude` command a tab starts with. Every tab gets its own conversation id so a restart
// reopens exactly that chat, not just the newest one in the folder.
//   new      -> claude --session-id <new uuid>
//   resume   -> claude --resume <cid>   (or a fresh start with that id if it never got a message)
//   continue -> resume the newest conversation of the folder, else new
//   pick     -> claude --resume (Claude's picker), id detected afterwards
function claudeLaunch(dir, mode, cid) {
  if (mode === 'pick') return { cmd: 'claude --resume', cid: null };
  if (mode === 'continue') { const last = conversations(dir)[0]; if (last && UUID.test(last.id)) { mode = 'resume'; cid = last.id; } else mode = 'new'; }
  if (mode === 'resume' && cid && UUID.test(cid)) {
    const exists = conversations(dir).some((c) => c.id === cid);
    return { cmd: exists ? `claude --resume ${cid}` : `claude --session-id ${cid}`, cid };
  }
  const fresh = require('crypto').randomUUID();
  return { cmd: `claude --session-id ${fresh}`, cid: fresh };
}

// Finds the conversation a "pick" tab ended up in: newest file touched since the tab started, not owned by another tab.
// ---------- drafts for the copy bar (Balazs 2026-11-11) ----------
// Reads the LAST assistant turn of a tab's conversation from its transcript and returns every message block Claude
// framed the brain way: a ---------- line, a fenced code block, optional "Case-Name: https://..." lines, a ---------- line.
// From the file, not the screen: the fullscreen TUI wraps and indents what it shows.
function lastAssistantText(file) {
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, 3 * 1024 * 1024);
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
  } catch { return ''; }
  const lines = buf.toString('utf8').split('\n');
  const parts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    const c = e?.message?.content;
    if (e.type === 'user') {
      const isPrompt = typeof c === 'string' || (Array.isArray(c) && c.some((x) => x.type === 'text'));
      if (isPrompt && parts.length) break; // reached the prompt that started this turn
      continue;
    }
    if (e.type === 'assistant' && Array.isArray(c)) {
      const t = c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
      if (t) parts.unshift(t);
    }
  }
  return parts.join('\n');
}
function parseDrafts(text) {
  const out = [];
  const re = /^-{10,}[ \t]*\n+```[^\n]*\n([\s\S]*?)\n```[ \t]*\n([\s\S]*?)^-{10,}[ \t]*$/gm;
  for (let m; (m = re.exec(text));) {
    let body = m[1].replace(/\s+$/, '');
    let subject = '';
    const first = body.match(/^\s*(Betreff|Subject)\s*:\s*(.*)\n?/i);
    if (first) { subject = first[2].trim(); body = body.slice(first[0].length).replace(/^\s*\n/, ''); }
    const links = [];
    for (const l of m[2].matchAll(/^\s*(?:([^\n:]{1,80}?):\s*)?(https?:\/\/\S+)\s*$/gm)) links.push({ name: (l[1] || '').trim(), url: l[2] });
    out.push({ kind: first ? 'email' : 'linkedin', subject, body, links, chars: [...body].length });
  }
  return out;
}
ipcMain.handle('transcript:drafts', (_e, { dir, cid }) => {
  if (!cid || !UUID.test(cid)) return [];
  return parseDrafts(lastAssistantText(path.join(convFolder(dir), `${cid}.jsonl`)));
});

ipcMain.handle('claude:detect', (_e, { dir, since, exclude }) => {
  const hit = conversations(dir).find((c) => c.mtime > since && !exclude.includes(c.id));
  return hit ? hit.id : null;
});
ipcMain.handle('history:has', (_e, dir) => hasHistory(dir));

// ---------- file system for the files panel and palette ----------
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.expo', '.next', 'dist', 'build', '.cache', '.godot', 'Library']);

ipcMain.handle('fs:list', (_e, dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .map((d) => ({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() }))
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } catch (err) { return { error: err.message }; }
});

// Breadth-first walk with hard limits so huge folders never freeze the UI.
ipcMain.handle('fs:search', (_e, { root, query, limit = 60 }) => {
  const q = query.toLowerCase();
  const hits = [];
  const queue = [root];
  let seen = 0;
  while (queue.length && seen < 20000 && hits.length < limit * 4) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of entries) {
      seen++;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { if (!SKIP.has(d.name)) queue.push(full); continue; }
      const rel = path.relative(root, full);
      const name = d.name.toLowerCase();
      const relL = rel.toLowerCase();
      const score = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : relL.includes(q) ? 3 : -1;
      if (score >= 0) hits.push({ path: full, rel, name: d.name, score });
    }
  }
  return hits.sort((a, b) => a.score - b.score || a.rel.length - b.rel.length).slice(0, limit);
});

ipcMain.handle('fs:create', (_e, { dir, name, folder }) => {
  const target = path.join(dir, name);
  if (fs.existsSync(target)) return { error: 'Exists already' };
  try { folder ? fs.mkdirSync(target) : fs.writeFileSync(target, ''); return { path: target }; } catch (err) { return { error: err.message }; }
});
// No rename and no delete on disk, by design (Balazs 2026-11-11): renaming or removing something in Dojo
// only changes Dojo's own overview (state file), never the folders on the machine. Do not add them back.
ipcMain.on('fs:open', (_e, p) => shell.openPath(p));
ipcMain.on('fs:reveal', (_e, p) => shell.showItemInFolder(p));

function createWindow() {
  const chrome = IS_WIN
    ? { icon: path.join(__dirname, 'assets', 'logo.ico'), titleBarStyle: 'hidden', titleBarOverlay: { color: '#060c1d', symbolColor: '#8fb4ff', height: 44 } }
    : { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 } };
  win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 900, minHeight: 560,
    backgroundColor: '#050a18',
    ...chrome,
    title: 'Dojo',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: !process.env.COCKPIT_SMOKE },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  // A file dropped outside a pane would navigate the window to it, and window.open would spawn a bare
  // Electron window. Both are blocked; web links go to the default browser instead.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  if (process.env.COCKPIT_SIZE) { const [w, h] = process.env.COCKPIT_SIZE.split('x').map(Number); if (w && h) win.setContentSize(w, h); }
  if (process.env.COCKPIT_SMOKE) {
    // Smoke test: renderer opens sessions itself, we screenshot and quit.
    win.webContents.once('did-finish-load', () => {
      win.webContents.executeJavaScript(process.env.COCKPIT_SMOKE_JS || '');
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.COCKPIT_SMOKE, img.toPNG());
        app.quit();
      }, Number(process.env.COCKPIT_SMOKE_MS || 9000));
    });
  }
  win.on('focus', () => win.webContents.send('win:focus', true));
  win.on('blur', () => win.webContents.send('win:focus', false));
}

ipcMain.handle('projects:list', () => discoverProjects());
ipcMain.handle('categories:load', () => {
  if (CONFIG.categories) return CONFIG.categories;
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'categories.json'), 'utf8')).categories; } catch { return []; }
});

// Optional extras for Claude tabs, whitelisted so the renderer can never inject shell text:
//   model -> --model <alias> (side question tab runs on Sonnet), start -> a fixed first prompt.
const MODELS = new Set(['sonnet', 'opus', 'haiku']);
const START_PROMPTS = { handoff: 'Read HANDOFF.md and CLAUDE.md, then do the next step.' };
ipcMain.handle('pty:create', (_e, { id, cwd, kind, mode, cid, cols, rows, model, start }) => {
  // Windows: PowerShell keeps its profile shortcuts. Mac: login shell (zsh) so PATH from .zprofile/.zshrc
  // finds `claude`; after Claude exits the shell stays open, same as -NoExit on Windows.
  const shellExe = IS_WIN ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');
  // COCKPIT_NOPROFILE: demo recordings start PowerShell without the user profile, so no private shortcuts show.
  const args = IS_WIN ? ['-NoLogo', ...(process.env.COCKPIT_NOPROFILE ? ['-NoProfile'] : [])] : ['-l'];
  let launch = { cid: null };
  if (kind === 'claude') {
    launch = claudeLaunch(cwd, mode, cid);
    if (MODELS.has(model)) launch.cmd += ` --model ${model}`;
    if (START_PROMPTS[start]) launch.cmd += IS_WIN ? ` '${START_PROMPTS[start]}'` : ` "${START_PROMPTS[start]}"`;
    if (IS_WIN) args.push('-NoExit', '-Command', launch.cmd);
    else args.push('-i', '-c', `${launch.cmd}; exec "${shellExe}" -l`);
  }
  const p = pty.spawn(shellExe, args, {
    name: 'xterm-256color', cols: cols || 120, rows: rows || 32, cwd,
    env: { ...cleanEnv(), COCKPIT_SESSION: id, DOJO_PORT: String(HOOK_PORT), DOJO_TOKEN: HOOK_TOKEN, FORCE_COLOR: '1', TERM_PROGRAM: 'Dojo' },
    ...(IS_WIN ? { useConpty: true } : {}),
  });
  ptys.set(id, p);
  p.onData((data) => win && !win.isDestroyed() && win.webContents.send('pty:data', { id, data }));
  p.onExit(({ exitCode }) => {
    ptys.delete(id);
    win && !win.isDestroyed() && win.webContents.send('pty:exit', { id, exitCode });
  });
  return { cid: launch.cid };
});

// Dojo started from inside a Claude session (npm start in a Claude tab, smoke test) would hand its
// Claude markers to every child: Claude then treats the tab as a sub-session and saves no transcript,
// which breaks --resume. Strip them so every tab is a top-level Claude.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  return env;
}

ipcMain.on('pty:write', (_e, { id, data }) => ptys.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows); } catch {} });
ipcMain.on('pty:kill', (_e, { id }) => { try { ptys.get(id)?.kill(); } catch {} ptys.delete(id); });

ipcMain.on('notify', (_e, { title, body, silent }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: !!silent });
  n.on('click', () => { win.show(); win.focus(); });
  n.show();
});

ipcMain.handle('clip:read', () => clipboard.readText());
ipcMain.on('clip:write', (_e, text) => clipboard.writeText(text));
// Rich copy for HubSpot: html keeps paragraphs and the hyperlinked case name, text is the plain fallback.
ipcMain.on('clip:writeRich', (_e, { text, html }) => clipboard.write({ text, html }));
ipcMain.on('open:folder', (_e, p) => shell.openPath(p));
// Links clicked in a terminal open in the default browser. Only web and mail links, never file:// or app schemes.
const EXTERNAL_OK = /^(https?|mailto):/i;
function openExternal(url) {
  if (!EXTERNAL_OK.test(String(url))) return;
  // Smoke test: record instead of launching the browser.
  if (process.env.COCKPIT_SMOKE) return fs.appendFileSync(process.env.COCKPIT_SMOKE + '.links', url + '\n');
  shell.openExternal(url);
}
ipcMain.on('open:external', (_e, url) => openExternal(url));

// Settings window values (font, theme, notifications ...) live in their own file so "Open settings file" shows only them.
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
ipcMain.handle('settings:load', () => {
  let values = {};
  try { values = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); } catch {}
  return { values, file: SETTINGS_FILE() };
});
ipcMain.on('settings:save', (_e, values) => { try { fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(values, null, 2)); } catch {} });

// ---------- insights (2026-11-16): stats, context per tab, hub radar, brain panel, new projects ----------
const insights = require('./insights');
const projectsWithExtra = () => discoverProjects();
ipcMain.handle('stats:get', (_e, days) => insights.stats(app.getPath('userData'), projectsWithExtra(), Number(days) || 0));
ipcMain.handle('context:get', (_e, { dir, cid }) => (cid && UUID.test(cid) ? insights.context(dir, cid) : null));
ipcMain.handle('prompt:first', (_e, { dir, cid }) => (cid && UUID.test(cid) ? insights.firstPrompt(dir, cid) : null));
ipcMain.handle('code:get', (_e, days) => insights.codeStats(projectsWithExtra(), Number(days) || 0));
ipcMain.handle('radar:get', () => insights.radar(projectsWithExtra()));
// Brain files are only read from inside a known project folder.
const knownProject = (dir) => projectsWithExtra().some((p) => path.resolve(p.path).toLowerCase() === path.resolve(String(dir)).toLowerCase());
ipcMain.handle('brain:files', (_e, dir) => (knownProject(dir) ? insights.brainFiles(dir) : []));
ipcMain.handle('brain:read', (_e, { dir, rel }) => (knownProject(dir) ? insights.brainRead(dir, rel) : null));
ipcMain.handle('brain:diff', (_e, { dir, rel }) => (knownProject(dir) ? insights.brainDiff(dir, rel) : null));
// New project: additive only (a new folder, optionally filled from _TEMPLATE). Never renames or deletes.
// Handoff: mtime of HANDOFF.md, so the renderer knows when /context-handoff has written it.
ipcMain.handle('handoff:mtime', (_e, dir) => { if (!knownProject(dir)) return 0; try { return fs.statSync(path.join(dir, 'HANDOFF.md')).mtimeMs; } catch { return 0; } });
// Push from the radar card or the palette. Plain `git push` to the configured upstream, never force.
ipcMain.handle('git:push', (_e, dir) => new Promise((res) => {
  if (!knownProject(dir)) return res({ ok: false, out: 'unknown project' });
  require('child_process').execFile('git', ['push'], { cwd: dir, timeout: 60000, windowsHide: true }, (err, out, errOut) =>
    res({ ok: !err, out: String(errOut || out || (err && err.message) || '').trim().split('\n').slice(-2).join(' ') }));
}));
ipcMain.handle('project:create', (_e, { name, template }) => insights.createProject(HUB, name, template));
// Week card: the renderer lays out the card, main captures exactly that rectangle as a PNG.
ipcMain.handle('card:capture', async (_e, { rect, save }) => {
  const img = await win.webContents.capturePage({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
  clipboard.writeImage(img);
  if (!save) return { copied: true };
  const dir = path.join(app.getPath('pictures'), 'Dojo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dojo-week-${new Date().toISOString().slice(0, 10)}.png`);
  fs.writeFileSync(file, img.toPNG());
  shell.showItemInFolder(file);
  return { copied: true, file };
});

ipcMain.handle('state:load', () => { try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { return null; } });
ipcMain.on('state:save', (_e, state) => { try { fs.writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2)); } catch {} });

app.setAppUserModelId('com.techwithbali.dojo');
if (process.env.COCKPIT_SMOKE) app.setPath('userData', path.join(app.getPath('temp'), 'dojo-smoke'));
// macOS: the default menu binds Cmd+W (close window) and Cmd+K etc. before the page sees them.
// Own menu keeps Quit/Hide and the edit roles, and leaves Cmd+W/K/1/2/Shift+E to the app.
function macMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Dojo', submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Settings…', accelerator: 'Cmd+,', click: () => win && !win.isDestroyed() && win.webContents.send('settings:open') },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    // Own edit menu: the default "Select All" only selects xterm's hidden textarea. This one marks the terminal
    // (or the focused text field). The renderer's Cmd+A handler does the same, so firing twice is harmless.
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { label: 'Select All', accelerator: 'Cmd+A', click: () => win && !win.isDestroyed() && win.webContents.send('edit:selectAll') },
    ] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ]));
}
app.setName('Dojo');
app.whenReady().then(() => {
  if (!IS_WIN) { macMenu(); try { app.dock.setIcon(path.join(__dirname, 'assets', 'logo-mac-1024.png')); } catch {} }
  createWindow();
});
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
app.on('window-all-closed', () => { for (const p of ptys.values()) { try { p.kill(); } catch {} } app.quit(); });
