// Workflow helpers (Balazs 2026-11-16, from the efficiency check: 97% of tokens are cache reads of long sessions).
//   Side question tab  (Ctrl+Shift+Q): throwaway Claude on Sonnet in the hub, keeps work sessions small.
//   Handoff            (status bar from 40% context): /context-handoff writes HANDOFF.md, then a fresh tab
//                      starts with "Read HANDOFF.md and CLAUDE.md, then do the next step."
//   Push               (radar chip "N unpushed", palette): plain git push, never force.
//   Quick actions      (palette): /verify, /log, handoff, push typed into the active Claude tab.

const HANDOFF_AT = 0.4;
const isSide = (s) => s.model === 'sonnet';

// Typed like a person: text first, Enter a moment later, so Claude's input box takes it as one command.
function sendToClaude(s, text) {
  if (!s || s.kind !== 'claude') return dojoToast('Open a Claude tab first'), false;
  if (s.status === 'working') return dojoToast('Claude is still working in this tab. Try again when it is done.'), false;
  api.write(s.id, text);
  setTimeout(() => api.write(s.id, '\r'), 180);
  s.term.focus();
  return true;
}

// ---------- side question ----------
async function openSideQuestion() {
  const hubProj = state.projects.find((p) => p.isHub) || currentProject() || state.projects[0];
  if (!hubProj) return;
  if (typeof launcher !== 'undefined' && launcher.open) closeLauncher(false);
  if (hub.open) toggleHub(false);
  await openSession(hubProj, 'claude', false, { model: 'sonnet', autoName: true });
  dojoToast('Side question on Sonnet: ask, read, close. Nothing lands in your work session.');
}

// ---------- handoff ----------
function startHandoff(s) {
  if (!sendToClaude(s, '/context-handoff')) return;
  s.handoffAt = Date.now();
  dojoToast('Claude writes HANDOFF.md. A fresh tab opens on its own when it is done.');
  renderContext();
}
async function handoffTurn(s) {
  if (!s.handoffAt || s.status === 'working') return;
  const m = await api.handoffMtime(s.project.path);
  if (!m || m < s.handoffAt) return; // the skill has not written it (yet), or Claude asked a question first
  s.handoffAt = 0;
  const base = (s.name || projName(s.project)).replace(/ \(\d+\)$/, '');
  const n = state.sessions.filter((x) => x.project.path === s.project.path).length + 1;
  await openSession(s.project, 'claude', false, { name: `${base} (${n})`, start: 'handoff' });
  dojoToast('Fresh tab started from HANDOFF.md. Close the old tab when you no longer need it.');
}
// status bar button, shown by renderContext() from 40%
$('#sum-ctx').addEventListener('click', (e) => {
  if (!e.target.closest('.handoff-btn')) return;
  const s = byId(state.activeId);
  if (s) startHandoff(s);
});

// ---------- push ----------
async function pushProject(dir, chip) {
  if (chip) { chip.classList.add('busy'); chip.textContent = 'Pushing …'; }
  const r = await api.gitPush(dir);
  dojoToast(r.ok ? `Pushed ${projName(state.projects.find((p) => p.path === dir) || { name: '' })}` : `Push failed: ${r.out || 'see the terminal'}`);
  if (hub.open && hub.view === 'radar') loadRadar(true);
  else hub.radar = null;
}
$('#hub-body').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip.push');
  if (!chip) return;
  e.stopPropagation(); // the card itself opens the project
  pushProject(chip.closest('.rcard').dataset.path, chip);
}, true);

// ---------- quick actions for the palette ----------
function quickActions(s) {
  const a = [{ label: 'Side question on Sonnet (new throwaway tab)', hint: 'Ctrl+Shift+Q', run: openSideQuestion }];
  if (s && s.kind === 'claude') a.unshift(
    { label: 'Verify: run the project check (/verify)', run: () => sendToClaude(s, '/verify') },
    { label: 'Log and commit this block (/log)', run: () => sendToClaude(s, '/log') },
    { label: 'Hand off to a fresh session (HANDOFF.md)', run: () => startHandoff(s) },
  );
  if (s) a.push({ label: `Push ${projName(s.project)} (git push)`, run: () => pushProject(s.project.path) });
  return a;
}
