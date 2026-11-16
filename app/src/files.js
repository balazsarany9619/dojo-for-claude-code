// Dojo files panel (Ctrl+Shift+E): lazy tree of the active session's project folder.
const fp = { open: false, root: null, expanded: new Set(), cache: new Map(), selected: null };

try { fp.open = localStorage.getItem('dojo.files') === '1'; } catch {}

const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const parentDir = (p) => p.replace(/[\\/][^\\/]+[\\/]?$/, '');
function relPath(p, root) {
  if (root && p.toLowerCase().startsWith(root.toLowerCase() + '\\')) return p.slice(root.length + 1).replace(/\\/g, '/');
  return p;
}

function toggleFiles(force) {
  fp.open = force ?? !fp.open;
  try { localStorage.setItem('dojo.files', fp.open ? '1' : '0'); } catch {}
  $('#files').classList.toggle('hidden', !fp.open);
  document.body.classList.toggle('files-open', fp.open);
  $('#toggle-files').classList.toggle('on', fp.open);
  if (fp.open) filesFollow(true);
  requestAnimationFrame(refit);
}

// Panel always shows the folder of the active session (or the hub when nothing is open).
function filesFollow(force) {
  if (!fp.open) return;
  const root = paletteRoot();
  if (!root || (root === fp.root && !force)) return;
  if (root !== fp.root) { fp.root = root; fp.expanded = new Set([root]); fp.selected = null; }
  fp.cache.clear();
  $('#files-root').textContent = activeSession() ? projName(activeSession().project) : 'Hub';
  $('#files-root').title = root;
  renderTree();
}

async function children(dir) {
  if (!fp.cache.has(dir)) {
    const res = await api.fsList(dir);
    fp.cache.set(dir, Array.isArray(res) ? res : []);
  }
  return fp.cache.get(dir);
}

async function renderTree() {
  const ul = $('#tree');
  const frag = document.createDocumentFragment();
  const walk = async (dir, depth) => {
    for (const e of await children(dir)) {
      const li = document.createElement('li');
      const open = e.dir && fp.expanded.has(e.path);
      li.className = `node${e.dir ? ' dir' : ' file'}${open ? ' open' : ''}${e.name.startsWith('.') ? ' hidden-file' : ''}${fp.selected === e.path ? ' sel' : ''}`;
      li.style.paddingLeft = `${10 + depth * 14}px`;
      li.innerHTML = `<span class="tw"></span><span class="ic"></span><span class="nm"></span>`;
      li.querySelector('.nm').textContent = e.name;
      li.title = e.path;
      li.draggable = !e.dir;
      li.addEventListener('click', () => onNodeClick(e));
      li.addEventListener('dblclick', () => { if (!e.dir) api.fsOpen(e.path); });
      li.addEventListener('contextmenu', (ev) => { ev.preventDefault(); fp.selected = e.path; markTreeSel(); showMenu(ev, nodeMenu(e)); });
      li.addEventListener('dragstart', (ev) => ev.dataTransfer.setData('text/dojo-path', e.path));
      li.dataset.path = e.path;
      frag.appendChild(li);
      if (open) await walk(e.path, depth + 1);
    }
  };
  if (fp.root) await walk(fp.root, 0);
  ul.innerHTML = '';
  ul.appendChild(frag);
  if (!ul.children.length) ul.innerHTML = '<li class="tree-empty">Empty folder</li>';
}

function markTreeSel() {
  for (const li of $('#tree').children) li.classList.toggle('sel', li.dataset.path === fp.selected);
}

function onNodeClick(e) {
  fp.selected = e.path;
  if (e.dir) {
    fp.expanded.has(e.path) ? fp.expanded.delete(e.path) : fp.expanded.add(e.path);
    renderTree();
  } else markTreeSel();
}

// Writes an @-mention into the active Claude session so the file becomes context.
function attachToSession(p) {
  const s = activeSession();
  if (!s) return;
  const rel = relPath(p, s.project.path);
  api.write(s.id, `@${/\s/.test(rel) ? `"${rel}"` : rel} `);
  s.term.focus();
}

function nodeMenu(e) {
  const s = activeSession();
  const dir = e.dir ? e.path : parentDir(e.path);
  const adhoc = { name: baseName(dir), path: dir };
  const reload = (d) => { fp.cache.delete(d); fp.expanded.add(d); renderTree(); };
  return [
    { label: 'New file …', action: () => promptText(e0, '', 'file name', async (v) => { if (!v) return; const r = await api.fsCreate(dir, v, false); if (r.error) flash(r.error); else { fp.selected = r.path; reload(dir); } }) },
    { label: 'New folder …', action: () => promptText(e0, '', 'folder name', async (v) => { if (!v) return; const r = await api.fsCreate(dir, v, true); if (r.error) flash(r.error); else reload(dir); }) },
    '-',
    ...(e.dir ? [] : [{ label: 'Open', hint: 'Double-click', action: () => api.fsOpen(e.path) }]),
    { label: 'Attach as context', hint: 'Drag to terminal', disabled: !s || s.kind !== 'claude', action: () => attachToSession(e.path) },
    { label: 'cd to directory', disabled: !s || s.kind !== 'shell', action: () => { api.write(s.id, `cd "${dir}"\r`); s.term.focus(); } },
    { label: 'Open in new tab (PowerShell)', action: () => openSession(adhoc, 'shell') },
    { label: 'New Claude conversation here', action: () => openSession(adhoc, 'claude', false) },
    { label: 'Reveal in Explorer', action: () => api.fsReveal(e.path) },
    '-',
    '-',
    { label: 'Copy path', action: () => api.clipWrite(e.path) },
    { label: 'Copy relative path', action: () => api.clipWrite(relPath(e.path, fp.root)) },
  ];
}

// Tiny toast for file errors.
function flash(msg) {
  const t = document.createElement('div');
  t.className = 'flash';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// Shell-quote a path like Terminal.app does on drop (backslash before every special character).
const shellQuote = (p) => (IS_MAC ? p.replace(/([^A-Za-z0-9_\-.,:\/@+=%~])/g, '\\$1') : (/[\s'"]/.test(p) ? `"${p}"` : p));

// Drop onto a terminal pane:
// - from the files panel = attach as @-mention (Claude session)
// - from Finder / Explorer = paste the escaped paths, exactly like a native terminal. Claude Code turns a
//   dropped image path into an attached image, other files become a path it can read.
const isFileDrag = (ev) => ev.dataTransfer.types.includes('Files') || ev.dataTransfer.types.includes('text/dojo-path');
const paneAt = (ev) => state.sessions.find((x) => x.pane === ev.target.closest?.('.pane'));
document.addEventListener('dragover', (ev) => {
  if (!isFileDrag(ev)) return;
  ev.preventDefault(); // without this Electron would open the dropped file in the window
  const s = paneAt(ev);
  ev.dataTransfer.dropEffect = s ? 'copy' : 'none';
  document.querySelectorAll('.pane.drop-target').forEach((p) => { if (p !== s?.pane) p.classList.remove('drop-target'); });
  s?.pane.classList.add('drop-target');
});
const clearDrop = () => document.querySelectorAll('.pane.drop-target').forEach((p) => p.classList.remove('drop-target'));
document.addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) clearDrop(); });
document.addEventListener('drop', (ev) => {
  if (!isFileDrag(ev)) return;
  ev.preventDefault();
  clearDrop();
  const s = paneAt(ev);
  if (!s || s.dead) return;
  activate(s.id);
  const own = ev.dataTransfer.getData('text/dojo-path');
  if (own) return attachToSession(own);
  const paths = [...ev.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return flash('Could not read the dropped file path');
  s.term.paste(paths.map(shellQuote).join(' ') + ' '); // paste() honours bracketed paste, so Claude sees it as a paste
  s.term.focus();
});

$('#toggle-files').addEventListener('click', () => toggleFiles());
$('#files-close').addEventListener('click', () => toggleFiles(false));
$('#files-refresh').addEventListener('click', (e) => refreshFeedback(e.currentTarget, async () => { filesFollow(true); return 'Up to date'; }));
if (fp.open) setTimeout(() => toggleFiles(true), 0);
