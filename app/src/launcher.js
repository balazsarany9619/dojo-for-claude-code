// New-session tab (Balazs 2026-11-16): "+" / Ctrl+T opens a "New session" tab with a start page instead of a second tab
// of the current project. Picking a project starts Claude there; the tab stays "New session" until the first prompt,
// then it is named after that prompt. A manual rename always wins.
var launcher = { open: false, prev: null, q: '', sel: 0 };

function openLauncher() {
  if (hub.open) toggleHub(false);
  // sort by recent use: the radar data carries the last activity per project
  if (!hub.radar) api.radar().then((r) => { hub.radar = r; hub.radarAt = Date.now(); if (launcher.open) renderLauncher(); });
  launcher.prev = state.activeId;
  launcher.open = true;
  launcher.q = '';
  launcher.sel = 0;
  state.activeId = null; // no session is active while the start page shows
  document.body.classList.add('launcher-open');
  $('#launcher').classList.remove('hidden');
  render();
  renderLauncher();
  requestAnimationFrame(() => $('#launcher-q').focus());
}
function closeLauncher(restore = true) {
  if (!launcher.open) return;
  launcher.open = false;
  document.body.classList.remove('launcher-open');
  $('#launcher').classList.add('hidden');
  if (restore && launcher.prev && byId(launcher.prev)) activate(launcher.prev);
  else render();
  requestAnimationFrame(refit);
}

// Projects in the order Balazs most likely wants: open sessions, then recently used (radar data if loaded), then A to Z.
function launcherProjects() {
  const recent = new Map((hub.radar || []).map((r) => [r.path, Math.max(r.lastChat || 0, r.logMtime || 0)]));
  const q = launcher.q.trim().toLowerCase();
  return state.projects
    .filter((p) => !meta(p).hidden && (!q || projName(p).toLowerCase().includes(q) || p.name.toLowerCase().includes(q)))
    .sort((a, b) => {
      const la = state.sessions.some((s) => s.project.path === a.path), lb = state.sessions.some((s) => s.project.path === b.path);
      if (la !== lb) return lb - la;
      return (recent.get(b.path) || 0) - (recent.get(a.path) || 0) || projName(a).localeCompare(projName(b));
    });
}
function renderLauncher() {
  const list = launcherProjects();
  launcher.sel = Math.max(0, Math.min(launcher.sel, list.length - 1));
  $('#launcher-grid').innerHTML = list.map((p, i) => {
    const live = state.sessions.filter((s) => s.project.path === p.path);
    return `<button class="lp${i === launcher.sel ? ' sel' : ''}" data-path="${esc(p.path)}" style="--c:${meta(p).color || 'transparent'}">
      <span class="lp-name">${esc(projName(p))}</span>
      <span class="lp-meta">${live.length ? `${live.length} open` : p.isHub ? 'general questions' : ''}${p.brain ? '' : ' · no brain'}</span></button>`;
  }).join('') || '<div class="hub-empty">No project matches.</div>';
  $('#launcher-grid').querySelectorAll('.lp').forEach((b) => {
    const p = state.projects.find((x) => x.path === b.dataset.path);
    b.addEventListener('click', (e) => launchIn(p, e.shiftKey ? 'shell' : 'claude'));
  });
}
async function launchIn(p, kind) {
  if (!p) return;
  closeLauncher(false);
  await openSession(p, kind, false);
  const s = state.sessions.at(-1);
  if (s && kind === 'claude') { s.autoName = true; render(); persist(); }
}

$('#launcher-q').addEventListener('input', (e) => { launcher.q = e.target.value; launcher.sel = 0; renderLauncher(); });
$('#launcher-q').addEventListener('keydown', (e) => {
  const list = launcherProjects();
  const cols = Math.max(1, Math.round($('#launcher-grid').clientWidth / 230));
  const move = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (move) { e.preventDefault(); launcher.sel = Math.max(0, Math.min(list.length - 1, launcher.sel + move)); renderLauncher(); }
  else if (e.key === 'Enter') { e.preventDefault(); launchIn(list[launcher.sel], e.shiftKey ? 'shell' : 'claude'); }
  else if (e.key === 'Escape') { e.preventDefault(); closeLauncher(); }
});

// ---------- automatic tab name from the first prompt ----------
// German nouns and names are capitalized, so the capitalized words carry the topic ("Projekt Dojo GitHub",
// "Landing Page Launch"). Voice input is often lowercase: then the first non-filler words are used.
const NAME_STOP = new Set(('ich du er sie es wir ihr mich mir dich dir uns euch kannst kann können könntest bitte mal ja e ein eine einen einem der die das den dem des '
  + 'und oder aber auch noch nur schon so jetzt dann wenn weil dass ob wie was wo wer warum welche welcher welches mit von zu zum zur im in an am auf aus bei für '
  + 'über unter nach vor ist sind war hab habe haben hat wird werden soll sollte möchte will würde gerne einfach quasi halt eigentlich genau also mein meine unser unsere um sein mehr sehr '
  + 'the a an and or but to of in on at for with is are was be can could would should please you your my me we our it this that check if hey hi hallo okay ok').split(' '));
function topicName(prompt) {
  if (!prompt) return '';
  if (prompt.startsWith('/')) return prompt.split(/\s/)[0];
  const words = prompt.replace(/[^\p{L}\p{N}\s.+#-]/gu, ' ').split(/\s+/).filter(Boolean);
  const caps = words.slice(1).filter((w) => /^\p{Lu}/u.test(w) && !NAME_STOP.has(w.toLowerCase()));
  const pick = caps.length >= 2 ? caps.slice(0, 3) : words.filter((w) => !NAME_STOP.has(w.toLowerCase()) && w.length > 1).slice(0, 4);
  let name = '';
  for (const w of [...new Set(pick)]) { if ((name + ' ' + w).trim().length > 30) break; name = (name + ' ' + w).trim(); }
  return name ? name[0].toUpperCase() + name.slice(1) : '';
}
async function autoNameSession(s) {
  if (!s || !s.autoName || s.name || !s.cid) return;
  const first = await api.firstPrompt(s.project.path, s.cid);
  const name = topicName(first);
  if (!name || !s.autoName || s.name) return;
  s.name = (s.model === 'sonnet' ? '? ' : '') + name; // side questions keep a marker
  s.autoName = false;
  render(); persist();
}
// Check on every finished turn and once a minute (hooks may be missing on Windows).
setInterval(() => state.sessions.forEach((s) => { if (s.autoName && !s.name) autoNameSession(s); }), 60000);
