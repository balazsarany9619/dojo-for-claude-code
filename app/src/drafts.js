// Copy bar (Balazs 2026-11-11): when Claude's last answer holds a message between the ---------- lines, a small bar floats
// above the input with the channel, the character count against the brain limit and one-click copy buttons.
//   LinkedIn: plain text with its line breaks (InMail has no formatting).
//   Email:    rich text for HubSpot, paragraphs kept and the case name carrying its link; the subject has its own button.
// The draft comes from the transcript (main.js transcript:drafts), not from the screen. Channel = "Betreff:" / "Subject:".
const DRAFT_LIMIT = { linkedin: 500, email: 700 };
const DRAFT_LABEL = { linkedin: 'LinkedIn', email: 'Email' };

async function refreshDrafts(s) {
  if (!s || s.kind !== 'claude' || !s.cid || s.dead) return;
  let d = [];
  try { d = await api.drafts(s.project.path, s.cid); } catch {}
  s.drafts = (d || []).slice(-3);
  s.draftsHidden = false;
  renderDraftBar(s);
}
function hideDrafts(s) { if (s.drafts?.length) { s.drafts = []; renderDraftBar(s); } }

const draftEsc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function draftHtml(d) {
  let html = draftEsc(d.body);
  for (const l of d.links) {
    if (!l.name) continue;
    const n = draftEsc(l.name), i = html.indexOf(n);
    if (i >= 0) html = `${html.slice(0, i)}<a href="${draftEsc(l.url)}">${n}</a>${html.slice(i + n.length)}`;
  }
  // HubSpot shows <p> without spacing (Balazs 2026-11-11 screenshot: blocks ran together). So one <p> per line and an
  // a <p>&nbsp;</p> for every blank line (an EMPTY <p> can be dropped by paste sanitizers, a non-breaking space survives).
  return `<meta charset="utf-8">${html.split('\n').map((line) => (line.trim() ? `<p>${line}</p>` : '<p>&nbsp;</p>')).join('')}`;
}

function copyDraft(s, d, what) {
  if (what === 'subject') { api.clipWrite(d.subject); return dojoToast(`Subject copied · ${[...d.subject].length} characters`); }
  if (d.kind === 'email') api.clipWriteRich(d.body, draftHtml(d));
  else api.clipWrite(d.body);
  const lim = DRAFT_LIMIT[d.kind];
  dojoToast(`${DRAFT_LABEL[d.kind]} message copied · ${d.chars}/${lim}${d.chars > lim ? ' · over the limit' : ''}${d.kind === 'email' && d.links.some((l) => l.name) ? ' · case link included' : ''}`);
  byId(state.activeId)?.term.focus();
}
function copyFirstDraft() {
  const s = byId(state.activeId);
  const d = s?.drafts?.at(-1);
  if (d) copyDraft(s, d, 'body'); else dojoToast('No message block in the last answer');
}

function renderDraftBar(s) {
  let bar = s.pane.querySelector('.draft-bar');
  if (!s.drafts?.length || s.draftsHidden) { bar?.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.className = 'draft-bar'; s.pane.querySelector('.term').appendChild(bar); }
  bar.innerHTML = '';
  const many = s.drafts.length > 1;
  s.drafts.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'draft-row';
    const lim = DRAFT_LIMIT[d.kind];
    const chip = document.createElement('span');
    chip.className = `draft-chip ${d.kind}${d.chars > lim ? ' over' : ''}`;
    chip.textContent = `${many ? `${i + 1} · ` : ''}${DRAFT_LABEL[d.kind]} ${d.chars}/${lim}`;
    chip.title = d.subject ? `Subject: ${d.subject}` : d.body.split('\n')[0];
    row.appendChild(chip);
    if (d.kind === 'email' && d.subject) {
      const sb = document.createElement('button');
      sb.className = 'draft-btn';
      sb.textContent = 'Copy subject';
      sb.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); copyDraft(s, d, 'subject'); });
      row.appendChild(sb);
    }
    const b = document.createElement('button');
    b.className = 'draft-btn primary';
    b.textContent = 'Copy message';
    b.title = d.kind === 'email' ? 'Formatted for HubSpot, the case name keeps its link (⌘⇧C copies the last one)' : 'Plain text for LinkedIn (⌘⇧C copies the last one)';
    b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); copyDraft(s, d, 'body'); });
    row.appendChild(b);
    bar.appendChild(row);
  });
  const x = document.createElement('button');
  x.className = 'draft-x';
  x.title = 'Hide until the next answer';
  x.textContent = '×';
  x.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); s.draftsHidden = true; renderDraftBar(s); });
  bar.appendChild(x);
}

function dojoToast(text) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), 1800);
  setTimeout(() => t.remove(), 2200);
}
