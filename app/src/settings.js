// Dojo settings: defaults, load/save, live apply, and the Settings window (Cmd+, or the gear in the top bar).
// Loaded BEFORE renderer.js. Names here must not clash with renderer.js (classic scripts share one global scope),
// so this file uses window.cockpit directly and prefixes its helpers with SET_ / set.
const SET_API = window.cockpit;
const SET_MAC = SET_API.platform === 'darwin';

const SETTINGS_DEFAULTS = {
  // Appearance
  theme: 'neon', glow: true, glass: true, splash: true, uiZoom: 100, sidebarWidth: 268,
  // Terminal
  fontFamily: 'default', fontSize: 13, lineHeight: 1.15, letterSpacing: 0, cursorStyle: 'block', cursorBlink: true,
  scrollRail: true, scrollSensitivity: 1, scrollback: 10000, semanticColors: true,
  // General
  restoreTabs: true, confirmCloseWorking: true,
  // Notifications
  notify: true, notifyDone: true, notifyApproval: true, notifySound: true,
};
let settings = { ...SETTINGS_DEFAULTS };
let settingsFile = '';

const SET_FONTS = {
  default: { label: 'Default (Menlo / Cascadia)', css: '"Cascadia Code", "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace' },
  menlo: { label: 'Menlo', css: 'Menlo, monospace' },
  monaco: { label: 'Monaco', css: 'Monaco, Menlo, monospace' },
  sfmono: { label: 'SF Mono', css: '"SF Mono", SFMono-Regular, Menlo, monospace' },
  jetbrains: { label: 'JetBrains Mono', css: '"JetBrains Mono", Menlo, monospace' },
  fira: { label: 'Fira Code', css: '"Fira Code", Menlo, monospace' },
  cascadia: { label: 'Cascadia Code', css: '"Cascadia Code", Menlo, monospace' },
  courier: { label: 'Courier New', css: '"Courier New", monospace' },
};

// Terminal palettes. Background stays transparent so the glass pane shows through.
const SET_THEMES = {
  neon: { label: 'Neon (glassy blue)', term: {
    background: '#00000000', foreground: '#dbe7ff', cursor: '#4fd2ff', cursorAccent: '#06102a',
    selectionBackground: '#2a5cff55', black: '#0b1530', red: '#ff5c8a', green: '#3dffb5', yellow: '#ffd166',
    blue: '#4f9dff', magenta: '#b78cff', cyan: '#4fe3ff', white: '#dbe7ff', brightBlack: '#5f7299',
    brightRed: '#ff86a8', brightGreen: '#7affcf', brightYellow: '#ffe08f', brightBlue: '#82bcff',
    brightMagenta: '#d0b3ff', brightCyan: '#8ff0ff', brightWhite: '#ffffff' } },
  midnight: { label: 'Midnight (calm, muted)', term: {
    background: '#00000000', foreground: '#c0caf5', cursor: '#7aa2f7', cursorAccent: '#1a1b26',
    selectionBackground: '#33467c88', black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
    blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6', brightBlack: '#565f89',
    brightRed: '#ff899d', brightGreen: '#b9f27c', brightYellow: '#ffc777', brightBlue: '#8db0ff',
    brightMagenta: '#c7a9ff', brightCyan: '#a4daff', brightWhite: '#c0caf5' } },
  graphite: { label: 'Graphite (neutral grey)', term: {
    background: '#00000000', foreground: '#e2e4e8', cursor: '#c9d1d9', cursorAccent: '#16181c',
    selectionBackground: '#5a627066', black: '#1b1d21', red: '#ef6b73', green: '#7fd49b', yellow: '#e7c27d',
    blue: '#7ea8e0', magenta: '#c59bdf', cyan: '#74c7d1', white: '#d7dae0', brightBlack: '#6b717c',
    brightRed: '#ff8a91', brightGreen: '#9ee6b5', brightYellow: '#f3d398', brightBlue: '#9dbfee',
    brightMagenta: '#d6b4ec', brightCyan: '#96d9e1', brightWhite: '#ffffff' } },
};

const termTheme = () => (SET_THEMES[settings.theme] || SET_THEMES.neon).term;
function termOptions() {
  return {
    fontFamily: (SET_FONTS[settings.fontFamily] || SET_FONTS.default).css,
    fontSize: settings.fontSize, lineHeight: settings.lineHeight, letterSpacing: settings.letterSpacing,
    cursorStyle: settings.cursorStyle, cursorBlink: settings.cursorBlink,
    scrollSensitivity: settings.scrollSensitivity, scrollback: settings.scrollback, theme: termTheme(),
  };
}

async function loadSettings() {
  try {
    const r = await SET_API.loadSettings();
    settings = { ...SETTINGS_DEFAULTS, ...(r?.values || {}) };
    settingsFile = r?.file || '';
  } catch {}
  applySettings();
}
function saveSettings() {
  const out = {};
  for (const k of Object.keys(settings)) if (settings[k] !== SETTINGS_DEFAULTS[k]) out[k] = settings[k]; // file holds only what you changed
  SET_API.saveSettings(out);
}
function setSetting(key, value) {
  settings[key] = value;
  applySettings();
  saveSettings();
}

// Everything is applied live: UI classes and variables, zoom, and the options of every open terminal.
function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.classList.toggle('no-glow', !settings.glow);
  root.classList.toggle('no-glass', !settings.glass);
  try { localStorage.setItem('dojo.splash', settings.splash ? 'on' : 'off'); } catch {} // splash.js reads it before settings load
  root.classList.toggle('rail-on', settings.scrollRail);
  root.style.setProperty('--sidebar-w', `${settings.sidebarWidth}px`);
  try { SET_API.setZoom(settings.uiZoom / 100); } catch {}
  if (typeof state !== 'undefined') {
    const opts = termOptions();
    for (const s of state.sessions) { try { Object.assign(s.term.options, opts); } catch {} }
    if (typeof refit === 'function') requestAnimationFrame(refit);
    if (typeof railUpdateAll === 'function') railUpdateAll();
  }
  if (!document.getElementById('settings')?.classList.contains('hidden')) settingsRenderPage();
}

// Notifications go through here so the switches in Settings decide. kind: 'done' | 'approval' | 'other'
function notifyIf(kind, title, body) {
  if (!settings.notify) return;
  if (kind === 'done' && !settings.notifyDone) return;
  if (kind === 'approval' && !settings.notifyApproval) return;
  SET_API.notify(title, body, !settings.notifySound);
}

// Terminal font size from the keyboard (Cmd + / Cmd - / Cmd 0), like Warp.
function bumpFontSize(d) { setSetting('fontSize', d === 0 ? SETTINGS_DEFAULTS.fontSize : Math.max(9, Math.min(28, settings.fontSize + d))); }

// ---------- Settings window ----------
const SET_KEY = (k) => (SET_MAC ? k : k.replace(/⌘/g, 'Ctrl').replace(/⌥/g, 'Alt').replace(/⇧/g, 'Shift').replace(/⌃/g, 'Ctrl'));
const SET_SHORTCUTS = [
  ['Sessions', 'Search sessions, projects, files', ['⌘', 'K']],
  ['Sessions', 'New conversation in this project', ['⌘', 'T']],
  ['Sessions', 'Close tab', ['⌘', 'W']],
  ['Sessions', 'Next tab', ['⌃', 'Tab']],
  ['Sessions', 'Previous tab', ['⌃', '⇧', 'Tab']],
  ['Sessions', 'Focus view (one session)', ['⌘', '1']],
  ['Sessions', 'Grid view (all sessions)', ['⌘', '2']],
  ['Sessions', 'Files panel', ['⌘', '⇧', 'E']],
  ['Sessions', 'Open settings', ['⌘', ',']],
  ['Text', 'Copy selection', ['⌘', 'C']],
  ['Text', 'Copy the message from the last answer (LinkedIn plain, email formatted)', ['⌘', '⇧', 'C']],
  ['Text', 'Paste', ['⌘', 'V']],
  ['Text', 'Mark your input text (whole terminal in plain tabs)', ['⌘', 'A']],
  ['Text', 'Replace or clear the marked input', ['⌘ A', '⌫ / type']],
  ['Text', 'New line in the input', ['⇧', 'Enter']],
  ['Text', 'Delete marked text', ['mark', '⌫']],
  ['Text', 'Delete word left', ['⌥', '⌫']],
  ['Text', 'Delete to line start', ['⌘', '⌫']],
  ['Text', 'Jump one word left / right', ['⌥', '← →']],
  ['Text', 'Jump to line start / end', ['⌘', '← →']],
  ['Text', 'Interrupt Claude / the shell', ['⌃', 'C']],
  ['Scrolling', 'Jump to the start of the conversation', ['⌘', '↑']],
  ['Scrolling', 'Jump to the latest message', ['⌘', '↓']],
  ['Scrolling', 'One page up / down', ['fn', '↑ ↓']],
  ['Scrolling', 'Drag the rail on the right (further = faster)', ['drag']],
  ['View', 'Bigger terminal text', ['⌘', '+']],
  ['View', 'Smaller terminal text', ['⌘', '−']],
  ['View', 'Reset terminal text size', ['⌘', '0']],
  ['Sidebar', 'Back into the project', ['click']],
  ['Sidebar', 'New conversation', ['⌘', 'click']],
  ['Sidebar', 'Terminal in the project folder', ['⇧', 'click']],
  ['Sidebar', 'Open the folder in Finder', ['⌥', 'click']],
  ['Sidebar', 'Rename, color, more', ['right-click']],
];

// Rows: [key, label, description, control]. Controls: toggle | select(options) | range(min,max,step,unit) | number(min,max)
const SET_PAGES = [
  { id: 'appearance', label: 'Appearance', sections: [
    { title: 'Theme', rows: [
      ['theme', 'Theme', 'Colors of the app and the terminal.', { select: Object.fromEntries(Object.entries(SET_THEMES).map(([k, v]) => [k, v.label])) }],
      ['glow', 'Neon glow', 'Glow around active tabs, panes and status dots. Off is calmer and easier on the eyes.', 'toggle'],
      ['glass', 'Glass blur', 'Frosted glass behind the panels. Off can feel snappier on battery.', 'toggle'],
      ['splash', 'Startup animation', 'Code rain, blue wind and a katana cut when Dojo opens (about 2.5 s, any key skips). Replay it from ⌘K.', 'toggle'],
    ] },
    { title: 'Size and layout', rows: [
      ['uiZoom', 'Interface size', 'Scales the whole window: sidebar, tabs, menus and terminal.', { range: [80, 140, 5, '%'] }],
      ['sidebarWidth', 'Sidebar width', 'Room for long project names.', { range: [220, 380, 10, 'px'] }],
    ] },
  ] },
  { id: 'terminal', label: 'Terminal', sections: [
    { title: 'Text', rows: [
      ['fontSize', 'Text size', 'Size of the terminal text. Also ⌘+ and ⌘− while you work.', { range: [9, 28, 1, 'px'] }],
      ['fontFamily', 'Font', 'Fonts that are not installed fall back to Menlo.', { select: Object.fromEntries(Object.entries(SET_FONTS).map(([k, v]) => [k, v.label])) }],
      ['lineHeight', 'Line spacing', 'More space between lines makes long answers easier to read.', { range: [1, 1.7, 0.05, '×'] }],
      ['letterSpacing', 'Letter spacing', 'Extra space between characters.', { range: [0, 3, 0.5, 'px'] }],
    ] },
    { title: 'Colors', rows: [
      ['semanticColors', 'Semantic colors in Claude tabs', 'Shell commands amber, file edits violet, reading cyan, calmer diff lines, your prompts on a blue bar. Applies to new output.', 'toggle'],
    ] },
    { title: 'Cursor', rows: [
      ['cursorStyle', 'Cursor shape', '', { select: { block: 'Block', bar: 'Bar', underline: 'Underline' } }],
      ['cursorBlink', 'Blinking cursor', '', 'toggle'],
    ] },
    { title: 'Scrolling', rows: [
      ['scrollRail', 'Scroll rail on the right', 'Drag it to move fast through long conversations, click above or below for a page, arrows jump to the start or the end.', 'toggle'],
      ['scrollSensitivity', 'Mouse wheel speed', 'How far one wheel step or trackpad swipe scrolls.', { range: [1, 6, 1, '×'] }],
      ['scrollback', 'Lines kept in terminal tabs', 'History of plain terminal tabs. Claude keeps its own history.', { number: [1000, 100000] }],
    ] },
  ] },
  { id: 'general', label: 'General', sections: [
    { title: 'Sessions', rows: [
      ['restoreTabs', 'Restore tabs on startup', 'Reopen every tab with its own conversation when Dojo starts.', 'toggle'],
      ['confirmCloseWorking', 'Ask before closing a working session', 'Prevents closing a tab while Claude is still in the middle of a turn.', 'toggle'],
    ] },
  ] },
  { id: 'notifications', label: 'Notifications', sections: [
    { title: 'Mac notifications', rows: [
      ['notify', 'Notifications', 'Only for sessions you are not looking at.', 'toggle'],
      ['notifyDone', 'When Claude is done', 'Claude finished a turn and waits for you.', 'toggle'],
      ['notifyApproval', 'When Claude needs approval', 'Claude asks before it goes on (needs the Dojo hooks).', 'toggle'],
      ['notifySound', 'Sound', '', 'toggle'],
    ] },
  ] },
  { id: 'shortcuts', label: 'Keyboard shortcuts' },
  { id: 'about', label: 'About' },
];
let setPage = 'appearance';

function openSettings(page) {
  if (page) setPage = page;
  const el = document.getElementById('settings');
  el.classList.remove('hidden');
  settingsRenderNav();
  settingsRenderPage();
  el.querySelector('#settings-search').value = '';
}
function closeSettings() {
  document.getElementById('settings').classList.add('hidden');
  if (typeof byId === 'function') byId(state.activeId)?.term.focus();
}

function settingsRenderNav() {
  const nav = document.getElementById('settings-nav');
  nav.innerHTML = '';
  for (const p of SET_PAGES) {
    const b = document.createElement('button');
    b.className = p.id === setPage ? 'on' : '';
    b.textContent = p.label;
    b.addEventListener('click', () => { setPage = p.id; settingsRenderNav(); settingsRenderPage(); });
    nav.appendChild(b);
  }
}

function settingsControl(key, ctl) {
  const v = settings[key];
  const wrap = document.createElement('div');
  wrap.className = 'set-ctl';
  if (ctl === 'toggle') {
    const t = document.createElement('button');
    t.className = `switch${v ? ' on' : ''}`;
    t.setAttribute('role', 'switch');
    t.setAttribute('aria-checked', String(!!v));
    t.addEventListener('click', () => setSetting(key, !settings[key]));
    wrap.appendChild(t);
  } else if (ctl.select) {
    const sel = document.createElement('select');
    for (const [k, label] of Object.entries(ctl.select)) sel.add(new Option(label, k, false, k === v));
    sel.addEventListener('change', () => setSetting(key, sel.value));
    wrap.appendChild(sel);
  } else if (ctl.range) {
    const [min, max, step, unit] = ctl.range;
    const r = document.createElement('input');
    Object.assign(r, { type: 'range', min, max, step, value: v });
    const out = document.createElement('span');
    out.className = 'set-val';
    const fmt = (x) => `${Number(x) % 1 ? Number(x).toFixed(2).replace(/0$/, '') : x}${unit === '×' ? '×' : unit}`;
    out.textContent = fmt(v);
    r.addEventListener('input', () => { out.textContent = fmt(r.value); settings[key] = Number(r.value); applySettings(); });
    r.addEventListener('change', () => setSetting(key, Number(r.value)));
    wrap.append(r, out);
  } else if (ctl.number) {
    const [min, max] = ctl.number;
    const n = document.createElement('input');
    Object.assign(n, { type: 'number', min, max, value: v });
    n.addEventListener('change', () => setSetting(key, Math.max(min, Math.min(max, Number(n.value) || SETTINGS_DEFAULTS[key]))));
    wrap.appendChild(n);
  }
  if (settings[key] !== SETTINGS_DEFAULTS[key]) {
    const reset = document.createElement('button');
    reset.className = 'set-reset';
    reset.title = 'Back to default';
    reset.textContent = '↺';
    reset.addEventListener('click', () => setSetting(key, SETTINGS_DEFAULTS[key]));
    wrap.prepend(reset);
  }
  return wrap;
}

function settingsRenderPage() {
  const body = document.getElementById('settings-body');
  const q = document.getElementById('settings-search').value.trim().toLowerCase();
  body.innerHTML = '';
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // Search runs across every page, like Warp's settings search.
  const pages = q ? SET_PAGES.filter((p) => p.sections) : SET_PAGES.filter((p) => p.id === setPage);
  if (!q && setPage === 'shortcuts') return settingsRenderShortcuts(body, h);
  if (!q && setPage === 'about') return settingsRenderAbout(body, h);
  let hits = 0;
  for (const p of pages) {
    if (!q) body.appendChild(h('h2', '', p.label));
    for (const sec of p.sections) {
      const rows = sec.rows.filter(([, label, desc]) => !q || `${label} ${desc}`.toLowerCase().includes(q));
      if (!rows.length) continue;
      body.appendChild(h('h3', '', q ? `${p.label} · ${sec.title}` : sec.title));
      const card = h('div', 'set-card');
      for (const [key, label, desc, ctl] of rows) {
        hits++;
        const row = h('div', 'set-row');
        const text = h('div', 'set-text');
        text.appendChild(h('div', 'set-label', label));
        if (desc) text.appendChild(h('div', 'set-desc', desc));
        row.append(text, settingsControl(key, ctl));
        card.appendChild(row);
      }
      body.appendChild(card);
    }
  }
  if (q && !hits) body.appendChild(h('div', 'set-empty', `Nothing found for "${q}".`));
}

function settingsRenderShortcuts(body, h) {
  body.appendChild(h('h2', '', 'Keyboard shortcuts'));
  body.appendChild(h('p', 'set-intro', 'Every shortcut Dojo knows. Ctrl keeps its terminal meaning, app shortcuts use ⌘.'));
  const search = h('input', 'set-filter');
  search.placeholder = 'Search by name or by keys (e.g. "⌘ K" or "delete")';
  search.spellcheck = false;
  body.appendChild(search);
  const table = h('div', 'set-card set-keys');
  body.appendChild(table);
  const draw = () => {
    const q = search.value.trim().toLowerCase().replace(/\s+/g, ' ');
    table.innerHTML = '';
    let group = '';
    for (const [g, label, keys] of SET_SHORTCUTS) {
      const keyText = keys.map(SET_KEY).join(' ').toLowerCase();
      if (q && !`${g} ${label}`.toLowerCase().includes(q) && !keyText.includes(q)) continue;
      if (g !== group) { group = g; table.appendChild(h('div', 'set-group', g)); }
      const row = h('div', 'set-row');
      row.appendChild(h('div', 'set-label', label));
      const kb = h('div', 'set-kbds');
      for (const k of keys) kb.appendChild(h('kbd', '', SET_KEY(k)));
      row.appendChild(kb);
      table.appendChild(row);
    }
  };
  search.addEventListener('input', draw);
  draw();
}

function settingsRenderAbout(body, h) {
  body.appendChild(h('h2', '', 'About Dojo'));
  const card = h('div', 'set-card');
  const line = (label, value) => { const r = h('div', 'set-row'); r.append(h('div', 'set-label', label), h('div', 'set-desc set-mono', value)); card.appendChild(r); };
  line('What it is', 'A session manager for Claude Code: every project one click away, a live status per session.');
  line('Settings file', settingsFile || 'not saved yet');
  line('Status', 'Exact status needs the Dojo hooks in ~/.claude/settings.json, otherwise Dojo estimates it from the output.');
  body.appendChild(card);
}

// Wiring that does not depend on renderer.js.
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('settings');
  el.addEventListener('mousedown', (e) => { if (e.target === el) closeSettings(); });
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-search').addEventListener('input', settingsRenderPage);
  document.getElementById('settings-file').addEventListener('click', () => { if (settingsFile) { saveSettings(); setTimeout(() => SET_API.fsReveal(settingsFile), 150); } });
  document.getElementById('open-settings').addEventListener('click', () => openSettings());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.classList.contains('hidden')) { e.stopPropagation(); closeSettings(); }
  }, true);
});
SET_API.onOpenSettings(() => openSettings());
