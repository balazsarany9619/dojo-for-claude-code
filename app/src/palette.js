// Dojo command palette (Ctrl+K): sessions, projects, files and actions in one list.
const PAL_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'session', label: 'Sessions' },
  { key: 'project', label: 'Projects' },
  { key: 'file', label: 'Files' },
  { key: 'action', label: 'Actions' },
];
const pal = { filter: 'all', items: [], sel: 0, fileHits: [], fileQuery: '', timer: null };

const activeSession = () => byId(state.activeId);
const paletteRoot = () => activeSession()?.project.path || state.projects.find((p) => p.isHub)?.path;

// Subsequence fuzzy score: lower is better, -1 = no match.
function fuzzy(text, q) {
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return direct;
  let ti = 0, gaps = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    gaps += found - ti; ti = found + 1;
  }
  return 50 + gaps;
}

function paletteActions() {
  const s = activeSession();
  const a = [
    { label: 'Toggle files panel', hint: 'Ctrl+Shift+E', run: () => toggleFiles() },
    { label: 'Settings', hint: 'Ctrl+,', run: () => openSettings() },
    { label: 'Play startup animation', run: () => playSplash() },
    { label: 'Copy the message from the last answer', hint: 'Ctrl+Shift+C', run: () => copyFirstDraft() },
    { label: 'Focus view', hint: 'Ctrl+1', run: () => setLayout('focus') },
    { label: 'Grid view', hint: 'Ctrl+2', run: () => setLayout('grid') },
    { label: 'Expand all project groups', run: () => { state.collapsed.clear(); renderProjects(); persist(); } },
    { label: 'Collapse all project groups', run: () => { state.collapsed = new Set(groupProjects().map((g) => g.name)); renderProjects(); persist(); } },
  ];
  if (typeof quickActions === 'function') a.unshift(...quickActions(s));
  if (s) a.unshift(
    { label: `New conversation in ${projName(s.project)}`, run: () => openSession(s.project, 'claude', false) },
    { label: `Pick an older conversation in ${projName(s.project)}`, run: () => openSession(s.project, 'claude', 'pick') },
    { label: 'Rename current session', run: () => renameSession(s, { clientX: innerWidth / 2 - 130, clientY: 120 }) },
    { label: 'Restart current session (continue conversation)', run: () => restartSession(s) },
    { label: `Open PowerShell in ${projName(s.project)}`, run: () => openSession(s.project, 'shell') },
    { label: 'Open project folder in Explorer', run: () => api.openFolder(s.project.path) },
    { label: 'Close current session', hint: 'Ctrl+W', run: () => closeSession(s.id) },
  );
  return a;
}

function buildPaletteItems() {
  const q = $('#palette-q').value.trim().toLowerCase();
  const want = (k) => pal.filter === 'all' || pal.filter === k;
  const out = [];
  const push = (kind, label, sub, run, extra = {}) => {
    const sc = fuzzy(`${label} ${sub || ''}`, q);
    if (sc >= 0) out.push({ kind, label, sub, run, sc, ...extra });
  };
  if (want('session')) for (const s of state.sessions)
    push('session', sessLabel(s), STATE_LABEL[s.status], () => activate(s.id), { dot: s.status, color: sessColor(s) });
  if (want('project')) for (const p of state.projects)
    push('project', projName(p), groupProjects().find((g) => g.projects.includes(p))?.name, () => goToProject(p), { color: meta(p).color });
  if (want('action')) for (const a of paletteActions()) push('action', a.label, '', a.run, { hint: a.hint });
  if (want('file')) for (const f of pal.fileHits)
    out.push({ kind: 'file', label: f.name, sub: f.rel, run: () => api.fsOpen(f.path), path: f.path, rel: f.rel, sc: 10 + f.score });

  const order = { session: 0, project: 1, action: 2, file: 3 };
  out.sort((a, b) => (q ? a.sc - b.sc : 0) || order[a.kind] - order[b.kind]);
  if (pal.filter === 'all' && !q) return out.filter((i) => i.kind !== 'file').slice(0, 40);
  return out.slice(0, 80);
}

function renderPalette() {
  $('#palette-chips').innerHTML = '';
  for (const f of PAL_FILTERS) {
    const b = document.createElement('button');
    b.className = `chip${pal.filter === f.key ? ' on' : ''}`;
    b.textContent = f.label;
    b.addEventListener('click', () => { pal.filter = f.key; pal.sel = 0; refreshFiles(); renderPalette(); $('#palette-q').focus(); });
    $('#palette-chips').appendChild(b);
  }
  pal.items = buildPaletteItems();
  pal.sel = Math.min(pal.sel, Math.max(0, pal.items.length - 1));
  const ul = $('#palette-list');
  ul.innerHTML = '';
  if (!pal.items.length) {
    const q = $('#palette-q').value.trim();
    ul.innerHTML = `<li class="empty">${pal.filter === 'file' && q.length < 2 ? 'Type at least 2 letters to search files' : 'Nothing found'}</li>`;
    return;
  }
  const ICON = { session: '›_', project: '◆', action: '⚡', file: '▤' };
  pal.items.forEach((it, i) => {
    const li = document.createElement('li');
    li.className = `${i === pal.sel ? 'sel' : ''}`;
    li.innerHTML = `<span class="pi pi-${it.kind}"></span><span class="pl"></span><span class="ps"></span><span class="pk"></span>`;
    const icon = li.querySelector('.pi');
    if (it.dot) icon.innerHTML = `<span class="dot ${it.dot}"></span>`; else icon.textContent = ICON[it.kind];
    if (it.color) icon.style.color = it.color;
    li.querySelector('.pl').textContent = it.label;
    li.querySelector('.ps').textContent = it.sub || '';
    li.querySelector('.pk').textContent = it.hint ? keyLabel(it.hint) : it.kind;
    li.addEventListener('mousemove', () => { if (pal.sel !== i) { pal.sel = i; markSel(); } });
    li.addEventListener('click', (e) => runPaletteItem(it, mod(e)));
    ul.appendChild(li);
  });
}

function markSel() {
  [...$('#palette-list').children].forEach((li, i) => li.classList.toggle('sel', i === pal.sel));
  $('#palette-list').children[pal.sel]?.scrollIntoView({ block: 'nearest' });
}

function runPaletteItem(it, ctrl) {
  closePalette();
  if (it.kind === 'file' && ctrl) return attachToSession(it.path);
  it.run();
}

// File search is async and debounced; it only runs for 2+ letters.
function refreshFiles() {
  const q = $('#palette-q').value.trim();
  clearTimeout(pal.timer);
  if (!(pal.filter === 'all' || pal.filter === 'file') || q.length < 2) { pal.fileHits = []; return; }
  if (q === pal.fileQuery) return;
  pal.timer = setTimeout(async () => {
    pal.fileQuery = q;
    pal.fileHits = await api.fsSearch(paletteRoot(), q);
    if (!$('#palette').classList.contains('hidden')) renderPalette();
  }, 140);
}

function openPalette(filter = 'all') {
  if (!$('#palette').classList.contains('hidden')) return closePalette();
  hideMenu();
  pal.filter = filter; pal.sel = 0; pal.fileHits = []; pal.fileQuery = '';
  $('#palette').classList.remove('hidden');
  $('#palette-q').value = '';
  renderPalette();
  $('#palette-q').focus();
}
function closePalette() {
  $('#palette').classList.add('hidden');
  activeSession()?.term.focus();
}

$('#palette-q').addEventListener('input', () => { pal.sel = 0; refreshFiles(); renderPalette(); });
$('#palette-q').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') return closePalette();
  if (e.key === 'ArrowDown') { e.preventDefault(); pal.sel = Math.min(pal.sel + 1, pal.items.length - 1); markSel(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pal.sel = Math.max(pal.sel - 1, 0); markSel(); }
  else if (e.key === 'Enter') { e.preventDefault(); const it = pal.items[pal.sel]; if (it) runPaletteItem(it, mod(e)); }
  else if (e.key === 'Tab') {
    e.preventDefault();
    const i = PAL_FILTERS.findIndex((f) => f.key === pal.filter);
    pal.filter = PAL_FILTERS[(i + (e.shiftKey ? -1 : 1) + PAL_FILTERS.length) % PAL_FILTERS.length].key;
    pal.sel = 0; pal.fileQuery = ''; refreshFiles(); renderPalette();
  } else if (mod(e) && e.key === 'k') { e.preventDefault(); closePalette(); }
});
$('#palette').addEventListener('mousedown', (e) => { if (e.target.id === 'palette') closePalette(); });
$('#open-palette').addEventListener('click', () => openPalette());
