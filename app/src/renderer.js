// Dojo renderer: sidebar of hub projects, session tabs, focus/grid layout, live status.
const api = window.cockpit;
// App shortcuts use Cmd on the Mac so Ctrl keeps its terminal meaning (Ctrl+C, Ctrl+W, Ctrl+K in readline).
const IS_MAC = api.platform === 'darwin';
const keyLabel = (h) => (IS_MAC ? h.replace(/Ctrl\+(?!Tab)/g, '⌘').replace('PowerShell', 'Terminal') : h);
const mod = (e) => (IS_MAC ? e.metaKey : e.ctrlKey);
if (IS_MAC) {
  document.documentElement.classList.add('mac');
  // Static labels in index.html are written for Windows, rewrite them once for the Mac.
  const swap = (t) => t.replace(/Ctrl K/g, '⌘K').replace(/Ctrl\+(?!Tab)/g, '⌘').replace('PowerShell', 'Terminal');
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) if (/Ctrl|PowerShell/.test(n.nodeValue)) n.nodeValue = swap(n.nodeValue);
  document.querySelectorAll('[title]').forEach((el) => { el.title = swap(el.title); });
}
const $ = (s) => document.querySelector(s);

const IDLE_AFTER_MS = 2500;     // quiet this long after output = turn finished
const ECHO_GRACE_MS = 400;      // output right after a keystroke is just echo
const HOOKED_SILENT_MS = 20000; // hooked tab, no output this long while "working" = interrupted, no Stop came

const state = { projects: [], categories: [], collapsed: new Set(), projectMeta: {}, sessions: [], activeId: null, layout: 'focus', windowFocused: true };
let seq = 0;

// Terminal colors, font and cursor come from settings.js (termOptions), changeable in Settings (Cmd+,).

// ---------- sessions ----------
// ---------- names and colors ----------
const COLORS = ['#4fe3ff', '#4f9dff', '#8b7cff', '#d06bff', '#ff5c8a', '#ff9f43', '#ffd166', '#3dffb5'];
const meta = (p) => state.projectMeta[p.path] || {};
const projName = (p) => meta(p).alias || p.name;
// Tabs opened with "+" stay "New session" until their first prompt names them (launcher.js).
const sessLabel = (s) => s.name || (s.autoName ? (s.model === 'sonnet' ? 'Side question' : 'New session') : `${projName(s.project)}${s.kind === 'shell' ? ' · PowerShell' : ''}`);
const sessColor = (s) => s.color || meta(s.project).color || '';
function setProjectMeta(p, patch) {
  const m = { ...meta(p), ...patch };
  for (const k of Object.keys(m)) if (!m[k]) delete m[k];
  if (Object.keys(m).length) state.projectMeta[p.path] = m; else delete state.projectMeta[p.path];
  render(); persist();
}

async function openSession(project, kind = 'claude', resume = false, saved = {}) {
  const id = `s${Date.now().toString(36)}${seq++}`;
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.innerHTML = `<div class="pane-head"><span class="dot"></span><span class="title"></span><span class="ctx"></span><span class="state"></span></div><div class="term"><div class="xt"></div></div>`;
  $('#stage').appendChild(pane);

  const term = new Terminal({
    ...termOptions(), allowProposedApi: true, allowTransparency: true,
    // OSC 8 hyperlinks (Claude Code prints these): open in the browser, no confirm dialog.
    linkHandler: { activate: (_e, uri) => api.openExternal(uri), allowNonHttpProtocols: false },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => api.openExternal(uri))); // plain URLs in the output
  term.open(pane.querySelector('.xt')); // fit measures .xt, so the padding on .term is not counted as rows

  const s = { id, project, kind, term, fit, pane, name: saved.name || '', autoName: !!saved.autoName, model: saved.model || '', color: saved.color || '', status: 'idle', lastOut: 0, lastKey: 0, workedSince: false, seen: true, dead: false };
  state.sessions.push(s);
  attachRail(s);

  term.attachCustomKeyEventHandler((e) => {
    // Shift+Enter = new line in the input. The keypress that follows the keydown must be swallowed too, otherwise
    // xterm sends a plain Enter after our ESC+CR and Claude submits (Balazs 2026-11-11: "schickt automatisch weg").
    if (e.shiftKey && e.key === 'Enter') { if (e.type === 'keydown') { e.preventDefault(); api.write(id, '\x1b\r'); } return false; }
    if (e.type !== 'keydown') return true;
    if (mod(e) && e.shiftKey && (e.key === 'c' || e.key === 'C')) { copyFirstDraft(); return false; } // copy bar, drafts.js
    if (mod(e) && e.key === 'c' && term.hasSelection()) { api.clipWrite(s.inputSel ? s.inputSel.text : term.getSelection()); term.clearSelection(); return false; }
    if (mod(e) && e.key === 'v') { api.clipRead().then((t) => t && api.write(id, t)); return false; }
    if (IS_MAC && e.metaKey && e.key === 'a') { selectInputOrAll(s); return false; } // Windows keeps Ctrl+A for the shell
    // Marked text + Backspace/Delete deletes it, typing over it replaces it (Balazs 2026-11-11). Outside the
    // input line the selection is only dropped, so a stray Backspace never eats a character of the input.
    if (term.hasSelection() && !e.metaKey && !e.ctrlKey) {
      if (e.key === 'Backspace' || e.key === 'Delete') { if (!deleteSelection(s)) term.clearSelection(); return false; }
      if (e.key.length === 1 && !e.altKey) deleteSelection(s);
    }
    // Cmd+Up / Cmd+Down: start / end of the conversation (Claude fullscreen) or of the terminal history.
    if (mod(e) && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { railJump(s, e.key === 'ArrowUp' ? 'top' : 'bottom'); return false; }
    if (mod(e) && ['=', '+', '-', '0', ','].includes(e.key)) return false; // text size and settings, handled by the window
    const edit = IS_MAC && macEditKey(e);
    if (edit) { api.write(id, edit); return false; }
    if (e.ctrlKey && e.key === 'Tab') return false;
    if (mod(e) && (e.key === 'w' || e.key === 'k' || e.key === '1' || e.key === '2')) return false;
    if (mod(e) && e.shiftKey && /^[EeHhBbQq]$/.test(e.key)) return false; // files, hub, brain panels, side question
    return true;
  });
  term.onSelectionChange(() => { if (!s.selectingInput) s.inputSel = null; });
  term.onData((d) => {
    s.lastKey = Date.now();
    if (s.status === 'approval') { s.status = 'working'; render(); } // answered the question, Claude goes on
    if (d.includes('\r')) {
      railAtBottom(s); hideDrafts(s); // sending: back to the newest output, old copy bar goes
      // Slash commands like /model start no turn, so re-read model and context shortly after every Enter.
      if (s.kind === 'claude' && typeof refreshContext === 'function') [1200, 3500].forEach((ms) => setTimeout(() => refreshContext(s), ms));
    }
    api.write(id, d);
  });
  pane.addEventListener('mousedown', (e) => { if (e.button !== 2) activate(id); });
  pane.addEventListener('contextmenu', (e) => { e.preventDefault(); activate(id); showMenu(e, paneMenu(s)); });

  activate(id);
  fit.fit();
  const mode = saved.cid ? 'resume' : resume === 'pick' ? 'pick' : resume ? 'continue' : 'new';
  s.startedAt = Date.now();
  const res = await api.createPty({ id, cwd: project.path, kind, mode, cid: saved.cid, cols: term.cols, rows: term.rows, model: saved.model, start: saved.start });
  s.cid = res?.cid || null;
  render();
  persist();
  if (kind === 'claude' && s.cid) setTimeout(() => { refreshDrafts(s); if (typeof refreshContext === 'function') refreshContext(s); }, 1500); // restored tab: last answer may hold a draft
}

// Plain click on a project: jump back into it instead of starting something new.
// 1) open Claude tab there -> focus it (waiting one first, repeated clicks cycle)
// 2) no tab but earlier conversations -> resume the last one (claude --continue)
// 3) never used -> fresh session
async function goToProject(p) {
  const mine = state.sessions.filter((s) => s.project.path === p.path && s.kind === 'claude' && !s.dead);
  if (mine.length) {
    const waiting = mine.find((s) => s.status === 'approval') || mine.find((s) => s.status === 'waiting');
    const cur = mine.findIndex((s) => s.id === state.activeId);
    return activate((waiting || (cur >= 0 ? mine[(cur + 1) % mine.length] : mine[0])).id);
  }
  openSession(p, 'claude', true); // main resumes the newest conversation, or starts fresh if there is none
}

function closeSession(id, force = false) {
  const i = state.sessions.findIndex((s) => s.id === id);
  if (i < 0) return;
  const s = state.sessions[i];
  if (!force && settings.confirmCloseWorking && s.kind === 'claude' && s.status === 'working'
    && !confirm(`Claude is still working in "${sessLabel(s)}". Close the tab anyway?`)) return;
  api.kill(id);
  s.term.dispose();
  s.pane.remove();
  state.sessions.splice(i, 1);
  if (state.activeId === id) state.activeId = state.sessions[Math.min(i, state.sessions.length - 1)]?.id || null;
  render(); refit(); persist();
}

function activate(id) {
  if (typeof launcher !== 'undefined' && launcher.open) closeLauncher(false); // switching tabs drops the start page
  state.activeId = id;
  const s = byId(id);
  if (s) { s.seen = true; if (s.status === 'waiting') s.status = 'idle'; }
  render();
  if (typeof filesFollow === 'function') filesFollow();
  if (typeof refreshBrain === 'function') refreshBrain(false);
  requestAnimationFrame(() => { refit(); byId(id)?.term.focus(); });
}

const byId = (id) => state.sessions.find((s) => s.id === id);

// ---------- text editing in the input line ----------
// A terminal selection is only a colored overlay, the input belongs to Claude Code (or the shell). Claude Code puts
// the real terminal cursor on its caret (checked in 2.1.322), so a selection on the cursor's row is inside the
// input: move the caret to the selection's end with arrow keys, then backspace over it. One row only.
function deleteSelection(s) {
  if (s.inputSel && s.term.hasSelection()) { clearInput(s); return true; }
  const r = s.term.getSelectionPosition();
  const b = s.term.buffer.active;
  const y = b.baseY + b.cursorY;
  s.term.clearSelection();
  if (!r || r.start.y !== y || r.end.y !== y) return false;
  const line = b.getLine(y);
  if (!line) return false;
  const textEnd = line.translateToString(true).length; // trailing blanks are not input, never backspace over them
  const from = r.start.x, to = Math.min(r.end.x, Math.max(textEnd, b.cursorX));
  if (to <= from) return true;
  const chars = (a, z) => [...line.translateToString(false, a, z)].length; // Claude moves by character, not by cell
  const cx = b.cursorX;
  let seq = cx < to ? '\x1b[C'.repeat(chars(cx, to)) : '\x1b[D'.repeat(chars(to, cx));
  seq += '\x7f'.repeat(chars(from, to));
  api.write(s.id, seq);
  return true;
}

// Cmd+A in a Claude tab marks only YOUR text in the input box (Balazs 2026-11-11: "nur den Chat-Teil"), not the whole
// terminal. The box sits between two rule lines (─) around the cursor row, its first row starts with "❯ ", the
// following rows are indented by two. Soft-wrapped rows (isWrapped) are one line, others are real line breaks.
// Returns null when no box is found (plain shells, menus), then Cmd+A marks the whole terminal as before.
function findInput(s) {
  if (s.kind !== 'claude') return null;
  const b = s.term.buffer.active, cy = b.baseY + b.cursorY;
  const text = (y) => b.getLine(y)?.translateToString(true) || '';
  const isRule = (y) => /^\s*─{6,}/.test(text(y));
  let top = cy, bot = cy;
  while (top > b.baseY && !isRule(top - 1)) top--;
  while (bot < b.baseY + s.term.rows - 1 && !isRule(bot + 1)) bot++;
  if (!isRule(top - 1) || !isRule(bot + 1) || !/^\s*❯/.test(text(top))) return null;
  const start = text(top).indexOf('❯') + 2;
  let out = '';
  for (let y = top; y <= bot; y++) {
    const line = b.getLine(y);
    const part = y === top ? text(y).slice(start) : text(y).replace(/^ {1,2}/, '');
    out += (y > top && !line?.isWrapped ? '\n' : '') + part;
  }
  while (bot > top && !text(bot).trim()) bot--; // empty rows below the text are not part of it
  return { top, bot, start, text: out.replace(/\s+$/, '') };
}
function selectInputOrAll(s) {
  const inp = findInput(s);
  s.inputSel = null;
  if (!inp || !inp.text) { s.term.selectAll(); return; }
  const lastLen = s.term.buffer.active.getLine(inp.bot).translateToString(true).length;
  s.selectingInput = true;
  s.term.select(inp.start, inp.top, (inp.bot - inp.top) * s.term.cols + lastLen - inp.start);
  s.selectingInput = false;
  s.inputSel = inp;
}
// Backspace / typing over the marked input: caret to the end of the input, then delete every character of it.
function clearInput(s) {
  const inp = s.inputSel;
  s.inputSel = null;
  s.term.clearSelection();
  const b = s.term.buffer.active, cy = b.baseY + b.cursorY;
  const n = [...inp.text].length;
  api.write(s.id, '\x1b[B'.repeat(Math.max(0, inp.bot - cy)) + '\x05' + '\x7f'.repeat(n + 2));
}

// Mac text shortcuts, translated into the readline keys Claude Code and zsh understand.
function macEditKey(e) {
  if (e.shiftKey || e.ctrlKey) return null;
  if (e.altKey && !e.metaKey) return { Backspace: '\x1b\x7f', ArrowLeft: '\x1bb', ArrowRight: '\x1bf' }[e.key] || null;
  if (e.metaKey && !e.altKey) return { Backspace: '\x15', ArrowLeft: '\x01', ArrowRight: '\x05' }[e.key] || null;
  return null;
}
const visible = (s) => state.layout === 'grid' || s.id === state.activeId;

api.onData(({ id, data }) => {
  const s = byId(id);
  if (!s) return;
  s.term.write(colorize(s, data)); // semantic colors for Claude output, colors.js
  const now = Date.now();
  if (now - s.lastKey > ECHO_GRACE_MS) {
    s.lastOut = now;
    // With hooks only Claude's own events start a turn: a redraw after a resize is output too, not work.
    if (!s.hooked && s.status !== 'working') { s.status = 'working'; s.workedSince = true; render(); }
  }
});

// ---------- exact status from Claude Code hooks (tools/dojo-hook.sh) ----------
// UserPromptSubmit / PostToolUse = working, Stop = turn over, Notification = Claude asks something
// (permission prompt and the like) except idle_prompt, which is only the 60 s "still waiting" reminder.
// SessionStart carries the conversation id, so /clear and /resume inside a tab keep the tab's id right.
const looking = (s) => state.windowFocused && visible(s) && s.id === state.activeId;
function turnOver(s, how) {
  const seen = looking(s);
  if (how === 'approval') s.status = 'approval';
  else s.status = seen ? 'idle' : 'waiting';
  s.seen = seen;
  if (!seen && s.kind === 'claude' && (s.workedSince || how === 'approval')) {
    if (how === 'approval') notifyIf('approval', `${projName(s.project)} needs approval`, 'Claude is asking before it goes on.');
    else notifyIf('done', `${projName(s.project)} is done`, 'Claude finished and is waiting for you.');
  }
  s.workedSince = false;
  render();
  refreshDrafts(s); // a finished turn may hold a message block for the copy bar
  if (typeof refreshContext === 'function') refreshContext(s);
  if (typeof refreshBrain === 'function' && s.id === state.activeId) refreshBrain(true);
  if (typeof autoNameSession === 'function') autoNameSession(s);
  if (typeof handoffTurn === 'function') handoffTurn(s);
}
api.onHook(({ tab, event, data }) => {
  const s = byId(tab);
  if (!s || s.dead) return;
  s.hooked = true;
  if (event === 'SessionStart') {
    if (data.session_id && data.session_id !== s.cid) { s.cid = data.session_id; persist(); }
    if (s.status === 'working') { s.status = 'idle'; render(); }
  } else if (event === 'UserPromptSubmit' || event === 'PostToolUse') {
    if (event === 'UserPromptSubmit') railAtBottom(s);
    s.lastOut = Date.now();
    if (s.status !== 'working') { s.status = 'working'; render(); }
    s.workedSince = true;
  } else if (event === 'Stop') {
    turnOver(s, 'done');
  } else if (event === 'Notification') {
    if (data.notification_type === 'idle_prompt') { if (s.status === 'working') turnOver(s, 'done'); }
    else turnOver(s, 'approval');
  }
});

api.onExit(({ id }) => {
  const s = byId(id);
  if (!s) return;
  s.dead = true; s.status = 'dead';
  s.term.write('\r\n\x1b[90m[Session ended. Ctrl+W closes the tab.]\x1b[0m\r\n');
  render();
});

api.onFocus((f) => { state.windowFocused = f; });
// Edit > Select All (Cmd+A): a focused text field (filter, palette, rename) selects its text, otherwise the active terminal.
api.onSelectAll(() => {
  const el = document.activeElement;
  if (el && el.tagName === 'INPUT') return el.select();
  const cur = byId(state.activeId);
  if (cur) selectInputOrAll(cur);
});

// Status tick: working -> waiting when output goes quiet.
setInterval(() => {
  let changed = false;
  for (const s of state.sessions) {
    if (s.status !== 'working') continue;
    const quiet = Date.now() - s.lastOut;
    // Hooked tabs: Stop decides. Only an interrupt (Esc, no Stop hook) is caught here, quietly, after 20 s
    // without any output (the spinner redraws every second while Claude works).
    if (s.hooked) { if (quiet > HOOKED_SILENT_MS) { s.status = 'idle'; s.workedSince = false; changed = true; } continue; }
    if (quiet > IDLE_AFTER_MS) {
      const seen = looking(s);
      s.status = seen ? 'idle' : 'waiting';
      s.seen = seen;
      changed = true;
      if (s.kind === 'claude') { refreshDrafts(s); if (typeof refreshContext === 'function') refreshContext(s); if (typeof autoNameSession === 'function') autoNameSession(s); if (typeof handoffTurn === 'function') handoffTurn(s); }
      if (!seen && s.kind === 'claude' && s.workedSince) {
        notifyIf('done', `${projName(s.project)} needs you`, 'Claude is done or waiting for an answer.');
      }
      s.workedSince = false;
    }
  }
  if (changed) render();
}, 500);

// ---------- layout ----------
function setLayout(l) {
  state.layout = l;
  document.querySelectorAll('.layout-switch button').forEach((b) => b.classList.toggle('active', b.dataset.layout === l));
  render();
  requestAnimationFrame(refit);
  persist();
}

function refit() {
  for (const s of state.sessions) {
    if (!visible(s)) continue;
    try { s.fit.fit(); api.resize(s.id, s.term.cols, s.term.rows); } catch {}
  }
}
new ResizeObserver(() => refit()).observe($('#stage'));

// ---------- rendering ----------
const STATE_LABEL = { working: 'working', waiting: 'needs you', approval: 'needs approval', idle: 'ready', dead: 'ended' };

function render() {
  const stage = $('#stage');
  stage.className = `layout-${state.layout}${state.sessions.length ? ' has-panes' : ''}`;
  const n = state.sessions.length;
  if (state.layout === 'grid' && n) {
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
    stage.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    stage.style.gridTemplateRows = `repeat(${Math.ceil(n / cols)}, 1fr)`;
  } else { stage.style.gridTemplateColumns = ''; stage.style.gridTemplateRows = ''; }

  // tabs (not rebuilt while a tab is being dragged, a rebuild would kill the drag source)
  const tabs = $('#tabs');
  if (!tabDrag.id) {
  tabs.innerHTML = '';
  for (const s of state.sessions) {
    const t = document.createElement('div');
    t.className = `tab${s.id === state.activeId ? ' active' : ''}${sessColor(s) ? ' colored' : ''}`;
    t.style.setProperty('--c', sessColor(s) || 'transparent');
    t.innerHTML = `<span class="dot ${s.status}"></span><span class="label"></span><span class="kind"></span><button class="x" title="Close">×</button>`;
    t.querySelector('.label').textContent = s.name || (s.autoName ? (s.model === 'sonnet' ? 'Side question' : 'New session') : projName(s.project));
    t.classList.toggle('side', s.model === 'sonnet');
    t.dataset.project = projName(s.project);
    t.querySelector('.kind').textContent = s.kind === 'shell' ? 'PS' : '';
    // No double-click rename (Balazs 2026-11-11: too easy to trigger by accident). Rename lives in the right-click menu.
    t.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeSession(s.id); } });
    t.addEventListener('click', (e) => { if (e.target.classList.contains('x')) closeSession(s.id); else activate(s.id); });
    t.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e, tabMenu(s)); });
    t.draggable = true;
    t.dataset.id = s.id;
    tabs.appendChild(t);
  }
  if (typeof launcher !== 'undefined' && launcher.open) {
    const t = document.createElement('div');
    t.className = 'tab active launcher-tab';
    t.innerHTML = '<span class="dot"></span><span class="label">New session</span><button class="x" title="Close">×</button>';
    t.addEventListener('click', (e) => { if (e.target.classList.contains('x')) closeLauncher(); });
    tabs.appendChild(t);
  }
  requestAnimationFrame(() => { tabs.querySelector('.tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); updateTabScroll(); });
  }

  // panes
  for (const s of state.sessions) {
    s.pane.classList.toggle('active', s.id === state.activeId);
    s.pane.classList.toggle('waiting', s.status === 'waiting');
    s.pane.classList.toggle('approval', s.status === 'approval');
    s.pane.querySelector('.dot').className = `dot ${s.status}`;
    s.pane.querySelector('.title').textContent = sessLabel(s);
    s.pane.style.setProperty('--c', sessColor(s) || 'transparent');
    s.pane.classList.toggle('colored', !!sessColor(s));
    s.pane.querySelector('.state').textContent = STATE_LABEL[s.status];
  }

  renderProjects();

  // status bar
  const count = (st) => state.sessions.filter((s) => s.status === st).length;
  const w = count('working'), q = count('waiting'), a = count('approval'), i = count('idle');
  $('#sum-working').innerHTML = w ? `<span class="dot working"></span>${w} working` : '';
  $('#sum-waiting').innerHTML = q ? `<span class="dot waiting"></span>${q} ${q === 1 ? 'needs' : 'need'} you` : '';
  $('#sum-approval').innerHTML = a ? `<span class="dot approval"></span>${a} ${a === 1 ? 'needs' : 'need'} approval` : '';
  $('#sum-idle').innerHTML = i ? `<span class="dot"></span>${i} ready` : '';
  document.title = q + a ? `(${q + a}) Dojo` : 'Dojo';
  if (typeof afterRender === 'function') afterRender();
}

function groupProjects() {
  const groups = state.categories.map((c) => ({ name: c.name, projects: [] }));
  const other = groups.find((g) => g.name === 'Other') || (groups.push({ name: 'Other', projects: [] }), groups.at(-1));
  for (const p of state.projects) {
    if (meta(p).hidden) continue; // removed from the sidebar, folder untouched
    const ci = state.categories.findIndex((c) => c.projects.includes(p.name));
    (ci >= 0 ? groups[ci] : other).projects.push(p);
  }
  for (const g of groups) {
    const order = state.categories.find((c) => c.name === g.name)?.projects || [];
    g.projects.sort((a, b) => ((order.indexOf(a.name) + 1) || 999) - ((order.indexOf(b.name) + 1) || 999) || a.name.localeCompare(b.name));
  }
  return groups.filter((g) => g.projects.length);
}

function renderProjects() {
  const f = $('#filter').value.trim().toLowerCase();
  const ul = $('#projects');
  ul.innerHTML = '';
  for (const g of groupProjects()) {
    const items = g.projects.filter((p) => !f || p.name.toLowerCase().includes(f) || projName(p).toLowerCase().includes(f));
    if (!items.length) continue;
    const open = f || !state.collapsed.has(g.name);
    const groupSessions = state.sessions.filter((s) => items.some((p) => p.path === s.project.path));
    const card = document.createElement('li');
    card.className = `group-card${open ? ' open' : ''}${groupSessions.length ? ' live' : ''}`;
    const head = document.createElement('div');
    head.className = `group${open ? ' open' : ''}`;
    head.innerHTML = `<span class="chev"></span><span class="gname"></span><span class="gcount">${items.length}</span><span class="dots"></span>`;
    head.querySelector('.gname').textContent = g.name;
    if (!open) head.querySelector('.dots').innerHTML = groupSessions.map((s) => `<span class="dot ${s.status}"></span>`).join('');
    head.addEventListener('click', () => {
      state.collapsed.has(g.name) ? state.collapsed.delete(g.name) : state.collapsed.add(g.name);
      renderProjects(); persist();
    });
    head.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e, groupMenu(g)); });
    card.appendChild(head);
    if (open) {
      const rows = document.createElement('ul');
      rows.className = 'rows';
      for (const p of items) rows.appendChild(projectItem(p));
      card.appendChild(rows);
    }
    ul.appendChild(card);
  }
}

function projectItem(p) {
  {
    const mine = state.sessions.filter((s) => s.project.path === p.path);
    const li = document.createElement('li');
    li.className = mine.length ? 'has-sessions' : '';
    li.innerHTML = `<span class="pcolor"></span><span class="name"></span>${p.brain ? '' : '<span class="nobrain">no brain</span>'}<span class="dots"></span><button class="new" title="New conversation (Ctrl+click)">+</button>`;
    li.querySelector('.name').textContent = projName(p);
    if (meta(p).alias) li.title = p.name;
    li.querySelector('.pcolor').style.background = meta(p).color || 'transparent';
    li.querySelector('.dots').innerHTML = mine.map((s) => `<span class="dot ${s.status}"></span>`).join('');
    li.addEventListener('click', (e) => {
      if (e.altKey) return api.openFolder(p.path);
      if (e.shiftKey) return openSession(p, 'shell');
      if (mod(e) || e.target.classList.contains('new')) return openSession(p, 'claude', false);
      goToProject(p);
    });
    li.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e, projectMenu(p)); });
    li.classList.add('project');
    return li;
  }
}

// ---------- context menus ----------
// Item: { label, hint?, action, danger?, disabled? } or '-' for a separator.
let e0 = null; // event that opened the current menu, used to place follow-up popovers
function showMenu(e, items) {
  hideMenu();
  e0 = { clientX: e.clientX, clientY: e.clientY };
  const m = document.createElement('div');
  m.id = 'ctxmenu';
  for (const it of items) {
    if (it === '-') { m.appendChild(Object.assign(document.createElement('div'), { className: 'sep' })); continue; }
    if (it.swatches) {
      const row = document.createElement('div');
      row.className = 'swatches';
      row.innerHTML = `<div class="sw-label"></div>`;
      row.querySelector('.sw-label').textContent = it.label;
      for (const c of ['', ...COLORS]) {
        const sw = document.createElement('button');
        sw.className = `sw${c === (it.current || '') ? ' on' : ''}${c ? '' : ' none'}`;
        sw.style.background = c || 'transparent';
        sw.title = c ? '' : (it.noneLabel || 'No color');
        sw.addEventListener('click', () => { hideMenu(); it.onPick(c); });
        row.appendChild(sw);
      }
      m.appendChild(row);
      continue;
    }
    const b = document.createElement('button');
    b.className = `${it.danger ? 'danger' : ''}${it.disabled ? ' disabled' : ''}`;
    b.innerHTML = `<span></span><kbd></kbd>`;
    b.querySelector('span').textContent = it.label;
    if (it.hint) b.querySelector('kbd').textContent = keyLabel(it.hint); else b.querySelector('kbd').remove();
    b.addEventListener('click', () => { hideMenu(); if (!it.disabled) it.action(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(e.clientX, innerWidth - r.width - 6)}px`;
  m.style.top = `${Math.min(e.clientY, innerHeight - r.height - 6)}px`;
}
function hideMenu() { document.getElementById('ctxmenu')?.remove(); }
window.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctxmenu')) hideMenu(); }, true);
window.addEventListener('blur', hideMenu);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });

function projectMenu(p) {
  const mine = state.sessions.filter((s) => s.project.path === p.path);
  return [
    { label: mine.length ? 'Go to open conversation' : 'Continue last conversation', action: () => goToProject(p) },
    { label: 'New conversation', hint: 'Ctrl+click', action: () => openSession(p, 'claude', false) },
    { label: 'Pick an older conversation …', action: () => openSession(p, 'claude', 'pick') },
    '-',
    { label: 'Open PowerShell here', hint: 'Shift+click', action: () => openSession(p, 'shell') },
    { label: 'Open folder in Explorer', hint: 'Alt+click', action: () => api.openFolder(p.path) },
    { label: 'Copy path', action: () => api.clipWrite(p.path) },
    '-',
    { label: 'Rename in Dojo …', action: () => promptText(e0, projName(p), p.name, (v) => setProjectMeta(p, { alias: v === p.name ? '' : v })) },
    { label: 'Move to category …', action: () => showMenu(e0, moveMenu(p)) },
    { swatches: true, label: 'Project color (also used for its tabs)', current: meta(p).color, onPick: (c) => setProjectMeta(p, { color: c }) },
    '-',
    { label: `Close all sessions here (${mine.length})`, danger: true, disabled: !mine.length, action: () => mine.forEach((s) => closeSession(s.id)) },
    { label: 'Remove from Dojo (folder stays)', danger: true, action: () => setProjectMeta(p, { hidden: true }) },
  ];
}

function tabMenu(s) {
  const others = state.sessions.filter((x) => x.id !== s.id);
  const i = state.sessions.indexOf(s);
  return [
    { label: 'Rename …', action: () => renameSession(s, e0) },
    { swatches: true, label: 'Tab color', current: s.color, noneLabel: 'Use project color', onPick: (c) => { s.color = c; render(); persist(); } },
    '-',
    { label: 'Restart (continue conversation)', disabled: s.kind !== 'claude', action: () => restartSession(s) },
    { label: 'New conversation in same project', action: () => openSession(s.project, 'claude', false) },
    { label: 'PowerShell in same folder', action: () => openSession(s.project, 'shell') },
    '-',
    { label: 'Move left', disabled: i === 0, action: () => moveSession(s, -1) },
    { label: 'Move right', disabled: i === state.sessions.length - 1, action: () => moveSession(s, 1) },
    { label: 'Open folder in Explorer', action: () => api.openFolder(s.project.path) },
    '-',
    { label: 'Close', hint: 'Ctrl+W', danger: true, action: () => closeSession(s.id) },
    { label: 'Close others', danger: true, disabled: !others.length, action: () => others.forEach((x) => closeSession(x.id)) },
    { label: 'Close to the right', danger: true, disabled: i === state.sessions.length - 1, action: () => state.sessions.slice(i + 1).forEach((x) => closeSession(x.id)) },
    { label: 'Close all', danger: true, action: () => [...state.sessions].forEach((x) => closeSession(x.id)) },
  ];
}

function paneMenu(s) {
  return [
    { label: 'Copy', hint: 'Ctrl+C', disabled: !s.term.hasSelection(), action: () => { api.clipWrite(s.term.getSelection()); s.term.clearSelection(); } },
    { label: 'Paste', hint: 'Ctrl+V', action: () => api.clipRead().then((t) => t && api.write(s.id, t)) },
    { label: 'Select input text', hint: IS_MAC ? 'Ctrl+A' : undefined, disabled: !findInput(s), action: () => selectInputOrAll(s) },
    { label: 'Select whole terminal', action: () => { s.inputSel = null; s.term.selectAll(); } },
    { label: 'Clear screen', action: () => s.term.clear() },
    '-',
    { label: 'Rename …', action: () => renameSession(s, e0) },
    { swatches: true, label: 'Tab color', current: s.color, noneLabel: 'Use project color', onPick: (c) => { s.color = c; render(); persist(); } },
    '-',
    { label: state.layout === 'grid' ? 'Focus view' : 'Grid view', hint: state.layout === 'grid' ? 'Ctrl+1' : 'Ctrl+2', action: () => setLayout(state.layout === 'grid' ? 'focus' : 'grid') },
    { label: 'Restart (continue conversation)', disabled: s.kind !== 'claude', action: () => restartSession(s) },
    '-',
    { label: 'Close session', hint: 'Ctrl+W', danger: true, action: () => closeSession(s.id) },
  ];
}

function groupMenu(g) {
  const names = groupProjects().map((x) => x.name);
  const isOther = g.name === 'Other'; // catch-all for unlisted projects, always exists
  const i = state.categories.findIndex((c) => c.name === g.name);
  const hidden = state.projects.filter((p) => meta(p).hidden);
  return [
    { label: 'New project in this category …', action: () => newProjectFlow(e0, true, g.name) },
    '-',
    { label: 'Rename category …', disabled: isOther, action: () => renameCategory(g.name) },
    { label: 'Move up', disabled: i <= 0, action: () => moveCategory(g.name, -1) },
    { label: 'Move down', disabled: i < 0 || i >= state.categories.length - 1, action: () => moveCategory(g.name, 1) },
    '-',
    { label: 'Expand all', action: () => { state.collapsed.clear(); renderProjects(); persist(); } },
    { label: 'Collapse all', action: () => { state.collapsed = new Set(names); renderProjects(); persist(); } },
    { label: `Show removed projects (${hidden.length})`, disabled: !hidden.length, action: () => hidden.forEach((p) => setProjectMeta(p, { hidden: '' })) },
    { label: 'Reset categories to default', disabled: !state.categoriesEdited, action: resetCategories },
    '-',
    { label: 'Delete category (projects move to Other)', danger: true, disabled: isOther, action: () => deleteCategory(g.name) },
  ];
}

// ---------- category editing ----------
// Edits live in the per-machine state file. config.*.json / categories.json stay the untouched defaults,
// so "Reset categories to default" can always go back. Categories hold project FOLDER names, not aliases.
const catByName = (n) => state.categories.find((c) => c.name === n);
function saveCategories() { state.categoriesEdited = true; renderProjects(); persist(); }
function renameCategory(name) {
  promptText(e0, name, name, (v) => {
    if (!v || v === name || catByName(v) || v === 'Other') return;
    catByName(name).name = v;
    if (state.collapsed.delete(name)) state.collapsed.add(v);
    saveCategories();
  });
}
function deleteCategory(name) {
  state.categories = state.categories.filter((c) => c.name !== name);
  state.collapsed.delete(name);
  saveCategories();
}
function moveCategory(name, dir) {
  const i = state.categories.findIndex((c) => c.name === name), j = i + dir;
  if (i < 0 || j < 0 || j >= state.categories.length) return;
  [state.categories[i], state.categories[j]] = [state.categories[j], state.categories[i]];
  saveCategories();
}
function moveProject(p, target) {
  for (const c of state.categories) c.projects = c.projects.filter((n) => n !== p.name);
  let c = catByName(target);
  if (!c && target !== 'Other') state.categories.push((c = { name: target, projects: [] }));
  if (c) c.projects.push(p.name); // without an explicit 'Other' entry, unlisted already means Other
  state.collapsed.delete(target);
  saveCategories();
}
function moveMenu(p) {
  const current = groupProjects().find((g) => g.projects.includes(p))?.name;
  const targets = [...new Set([...state.categories.map((c) => c.name), 'Other'])];
  return [
    ...targets.map((n) => ({ label: n === current ? `${n} (current)` : n, disabled: n === current, action: () => moveProject(p, n) })),
    '-',
    { label: 'New category …', action: () => promptText(e0, '', 'New category name', (v) => { if (v && v !== 'Other' && !catByName(v)) moveProject(p, v); }) },
  ];
}
async function resetCategories() {
  state.categories = await api.loadCategories();
  state.categoriesEdited = false;
  state.collapsed = new Set(state.categories.filter((c) => c.collapsed).map((c) => c.name));
  renderProjects(); persist();
}

// Small inline text popover. Enter saves, Esc cancels, empty input resets to the default.
function promptText(at, current, fallback, onDone) {
  hideMenu();
  const box = document.createElement('div');
  box.id = 'ctxmenu';
  box.className = 'prompt';
  box.innerHTML = `<input spellcheck="false" /><div class="prompt-hint">Enter to save · Esc to cancel · empty resets</div>`;
  const input = box.querySelector('input');
  input.value = current;
  input.placeholder = fallback;
  document.body.appendChild(box);
  const r = box.getBoundingClientRect();
  box.style.left = `${Math.min(at?.clientX ?? 300, innerWidth - r.width - 6)}px`;
  box.style.top = `${Math.min(at?.clientY ?? 60, innerHeight - r.height - 6)}px`;
  input.focus(); input.select();
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { hideMenu(); onDone(input.value.trim()); byId(state.activeId)?.term.focus(); }
    else if (ev.key === 'Escape') { hideMenu(); byId(state.activeId)?.term.focus(); }
  });
}

function renameSession(s, at) {
  promptText(at, s.name || projName(s.project), projName(s.project), (v) => {
    s.name = v === projName(s.project) ? '' : v;
    s.autoName = false; // a manual name always wins over the automatic one
    render(); persist();
  });
}

// Drag a tab to reorder it. Drop position = before or after the tab under the cursor (by its midpoint).
const tabDrag = { id: null };
function moveSessionTo(s, index) {
  const i = state.sessions.indexOf(s);
  if (i < 0) return;
  state.sessions.splice(i, 1);
  state.sessions.splice(Math.max(0, Math.min(index > i ? index - 1 : index, state.sessions.length)), 0, s);
  const stage = $('#stage');
  state.sessions.forEach((x) => stage.appendChild(x.pane)); // keep grid order in sync
  render(); refit(); persist();
}
function tabDropSpot(ev) {
  const tabs = [...$('#tabs').querySelectorAll('.tab')];
  for (const [k, t] of tabs.entries()) {
    const r = t.getBoundingClientRect();
    if (ev.clientX < r.left + r.width / 2) return { index: k, el: t, side: 'before' };
  }
  return { index: tabs.length, el: tabs[tabs.length - 1], side: 'after' };
}
const clearTabMarks = () => $('#tabs').querySelectorAll('.drop-before, .drop-after, .dragging').forEach((t) => t.classList.remove('drop-before', 'drop-after', 'dragging'));
$('#tabs').addEventListener('dragstart', (ev) => {
  const t = ev.target.closest('.tab');
  if (!t) return;
  tabDrag.id = t.dataset.id;
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/dojo-tab', t.dataset.id);
  requestAnimationFrame(() => t.classList.add('dragging'));
});
$('#tabs').addEventListener('dragover', (ev) => {
  if (!tabDrag.id) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  const spot = tabDropSpot(ev);
  $('#tabs').querySelectorAll('.drop-before, .drop-after').forEach((t) => t.classList.remove('drop-before', 'drop-after'));
  spot.el?.classList.add(`drop-${spot.side}`);
});
$('#tabs').addEventListener('drop', (ev) => {
  if (!tabDrag.id) return;
  ev.preventDefault();
  const s = byId(tabDrag.id), spot = tabDropSpot(ev);
  tabDrag.id = null;
  clearTabMarks();
  if (s) moveSessionTo(s, spot.index);
});
$('#tabs').addEventListener('dragend', () => { if (tabDrag.id) { tabDrag.id = null; clearTabMarks(); render(); } });

function moveSession(s, dir) {
  const i = state.sessions.indexOf(s), j = i + dir;
  if (j < 0 || j >= state.sessions.length) return;
  [state.sessions[i], state.sessions[j]] = [state.sessions[j], state.sessions[i]];
  const stage = $('#stage');
  state.sessions.forEach((x) => stage.appendChild(x.pane)); // keep grid order in sync
  render(); refit(); persist();
}

async function restartSession(s) {
  const i = state.sessions.indexOf(s);
  closeSession(s.id, true);
  await openSession(s.project, 'claude', true, { name: s.name, color: s.color, cid: s.cid });
  const n = state.sessions.at(-1);
  state.sessions.splice(state.sessions.length - 1, 1);
  state.sessions.splice(i, 0, n);
  state.sessions.forEach((x) => $('#stage').appendChild(x.pane));
  activate(n.id); persist();
}

// ---------- persistence ----------
function persist() {
  api.saveState({
    layout: state.layout,
    collapsed: [...state.collapsed],
    projectMeta: state.projectMeta,
    categories: state.categoriesEdited ? state.categories : undefined,
    sessions: state.sessions.filter((s) => !s.dead).map((s) => ({ path: s.project.path, kind: s.kind, name: s.name, color: s.color, cid: s.cid || null, autoName: !!s.autoName, model: s.model || '' })),
    active: state.sessions.findIndex((s) => s.id === state.activeId),
  });
}

// Tabs opened via Claude's own picker learn their conversation id once Claude writes to it.
setInterval(async () => {
  for (const s of state.sessions) {
    if (s.kind !== 'claude' || s.cid || s.dead) continue;
    const exclude = state.sessions.map((x) => x.cid).filter(Boolean);
    const found = await api.detectConversation(s.project.path, s.startedAt, exclude);
    if (found) { s.cid = found; persist(); }
  }
}, 4000);
window.addEventListener('beforeunload', persist);

// ---------- tab strip: scroll with the mouse wheel, fades and arrows show hidden tabs (Balazs 2026-11-11) ----------
// The "+" sits outside the scrolling strip so it never scrolls out of sight.
function updateTabScroll() {
  const tabs = $('#tabs'), strip = $('#tabstrip');
  const max = tabs.scrollWidth - tabs.clientWidth;
  const left = tabs.scrollLeft > 2, right = tabs.scrollLeft < max - 2;
  strip.classList.toggle('more-left', left);
  strip.classList.toggle('more-right', right);
  const r = tabs.getBoundingClientRect();
  let l = 0, rr = 0;
  for (const t of tabs.querySelectorAll('.tab')) {
    const b = t.getBoundingClientRect();
    if (b.left < r.left - 4 + b.width / 2) l++; else if (b.right > r.right + 4 - b.width / 2) rr++;
  }
  $('#tabs-left .n').textContent = l || '';
  $('#tabs-right .n').textContent = rr || '';
}
$('#tabs').addEventListener('wheel', (e) => {
  const tabs = $('#tabs');
  if (tabs.scrollWidth <= tabs.clientWidth) return;
  const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX; // mouse wheel scrolls sideways here
  tabs.scrollLeft += d;
  e.preventDefault();
}, { passive: false });
$('#tabs').addEventListener('scroll', updateTabScroll, { passive: true });
new ResizeObserver(updateTabScroll).observe($('#tabs'));
for (const [sel, dir] of [['#tabs-left', -1], ['#tabs-right', 1]]) {
  $(sel).addEventListener('click', () => { const t = $('#tabs'); t.scrollBy({ left: dir * t.clientWidth * 0.7, behavior: 'smooth' }); });
}
$('#tab-add').addEventListener('click', (e) => newTabFromPlus(e));
$('#tab-add').addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e, newSessionMenu()); });

// ---------- new session from the tab bar ----------
function currentProject() { return byId(state.activeId)?.project || null; }
function newSessionMenu() {
  const cur = currentProject();
  const items = [];
  if (cur) items.push({ label: `New conversation · ${projName(cur)}`, hint: 'Cmd+T', action: () => openSession(cur, 'claude', false) }, '-');
  for (const p of state.projects) if (!meta(p).hidden) items.push({ label: projName(p), action: () => openSession(p, 'claude', false) });
  return items;
}
// "+" opens the start page in a "New session" tab (Balazs 2026-11-16), Shift+click a terminal in the current project.
function newTabFromPlus(e) {
  const cur = currentProject();
  if (cur && e.shiftKey) return openSession(cur, 'shell');
  openLauncher();
}

// ---------- keys ----------
window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey && !mod(e)) return;
  if (e.ctrlKey && e.key === 'Tab' && state.sessions.length) {
    e.preventDefault();
    const i = state.sessions.findIndex((s) => s.id === state.activeId);
    const next = (i + (e.shiftKey ? -1 : 1) + state.sessions.length) % state.sessions.length;
    activate(state.sessions[next].id);
  } else if (!mod(e)) return;
  else if (e.key === 'w' && state.activeId) { e.preventDefault(); closeSession(state.activeId); }
  else if (e.key === 'k') { e.preventDefault(); openPalette(); }
  else if (e.key === 't' && !e.shiftKey) { e.preventDefault(); openLauncher(); }
  else if (e.shiftKey && (e.key === 'E' || e.key === 'e')) { e.preventDefault(); toggleFiles(); }
  else if (e.shiftKey && (e.key === 'H' || e.key === 'h')) { e.preventDefault(); toggleHub(); }
  else if (e.shiftKey && (e.key === 'B' || e.key === 'b')) { e.preventDefault(); toggleBrain(); }
  else if (e.shiftKey && (e.key === 'Q' || e.key === 'q')) { e.preventDefault(); openSideQuestion(); }
  else if (e.key === ',') { e.preventDefault(); openSettings(); }
  else if (e.key === '=' || e.key === '+') { e.preventDefault(); bumpFontSize(1); }
  else if (e.key === '-') { e.preventDefault(); bumpFontSize(-1); }
  else if (e.key === '0') { e.preventDefault(); bumpFontSize(0); }
  else if (e.key === '1') { e.preventDefault(); setLayout('focus'); }
  else if (e.key === '2') { e.preventDefault(); setLayout('grid'); }
}, true);

$('#filter').addEventListener('input', renderProjects);
$('#filter').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = $('#projects li.project');
    if (first) first.dispatchEvent(new MouseEvent('click', { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey }));
    $('#filter').value = ''; renderProjects();
  } else if (e.key === 'Escape') { $('#filter').value = ''; renderProjects(); byId(state.activeId)?.term.focus(); }
});
document.querySelectorAll('.layout-switch button').forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.layout)));

// ---------- boot ----------
(async () => {
  await loadSettings();
  state.projects = await api.listProjects();
  state.categories = await api.loadCategories();
  const saved = await api.loadState();
  if (Array.isArray(saved?.categories)) { state.categories = saved.categories; state.categoriesEdited = true; }
  state.collapsed = new Set(saved?.collapsed ?? state.categories.filter((c) => c.collapsed).map((c) => c.name));
  state.projectMeta = saved?.projectMeta || {};
  renderProjects();
  if (saved?.layout) setLayout(saved.layout);
  for (const ss of settings.restoreTabs ? saved?.sessions || [] : []) {
    const p = state.projects.find((x) => x.path === ss.path);
    if (p) await openSession(p, ss.kind, ss.kind === 'claude', ss); // resume last conversation
  }
  if (saved?.active >= 0 && state.sessions[saved.active]) activate(state.sessions[saved.active].id);
  render();
  state.booted = true; // insights-ui.js may load after this point (IPC can win the race), it checks the flag itself
  if (!state.sessions.length && typeof toggleHub === 'function') toggleHub(true);
})();
