// Dojo insights UI (2026-11-16, Balazs): context meter per tab, Hub view (Radar + Stats + week card),
// Brain panel with session wrap-up, new projects from the sidebar. Loaded after renderer.js.
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTok = (n) => (n >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const fmtUsd = (n) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
const fmtHours = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${(m / 60).toFixed(m < 600 ? 1 : 0)} h`; };
const fmtLines = (n) => (n >= 10000 ? `${+(n / 1000).toFixed(1)}k` : n.toLocaleString('en'));
const tokSum = (r) => r.in + r.cw5 + r.cw1h + r.cr + r.out;
function ago(t) {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 1.5) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)} days ago`;
  return `${Math.round(s / 86400 / 30)} months ago`;
}

// ================= context meter =================
// What the conversation currently holds = input side of Claude's last message (plus its answer), from the transcript.
async function refreshContext(s) {
  if (!s || s.kind !== 'claude' || !s.cid || s.dead) return;
  const c = await api.context(s.project.path, s.cid);
  if (!c) return;
  s.ctx = c;
  renderContext();
}
const ctxLevel = (p) => (p < 0.5 ? 'ok' : p < 0.8 ? 'mid' : 'high');
function ctxText(c) { return `${fmtTok(c.used)} / ${fmtTok(c.window)}`; }
function renderContext() {
  for (const s of state.sessions) {
    const tab = document.querySelector(`#tabs .tab[data-id="${s.id}"]`);
    const head = s.pane.querySelector('.pane-head .ctx');
    if (!s.ctx) { if (head) head.innerHTML = ''; continue; }
    const p = Math.min(1, s.ctx.used / s.ctx.window), lvl = ctxLevel(p);
    if (tab) {
      // No line under the tab (Balazs 2026-11-16: looked broken on the tab border). A small chip only once it matters.
      let chip = tab.querySelector('.ctxpct');
      if (p >= 0.5) {
        if (!chip) { chip = document.createElement('span'); tab.querySelector('.x')?.before(chip); }
        chip.className = `ctxpct ${lvl}`;
        chip.textContent = `${Math.round(p * 100)}%`;
      } else chip?.remove();
      tab.title = `${projName(s.project)} · ${modelName(s.ctx.model)}${s.ctx.effort ? ` · ${s.ctx.effort} effort` : ""} · context ${Math.round(p * 100)}% · ${ctxText(s.ctx)} tokens`;
    }
    if (head) head.innerHTML = `<span class="ctxmeter ${lvl}" style="--p:${(p * 100).toFixed(1)}%"></span>${Math.round(p * 100)}%`;
  }
  const cur = byId(state.activeId);
  const el = $('#sum-ctx');
  if (!el) return;
  if (cur?.ctx) {
    const p = Math.min(1, cur.ctx.used / cur.ctx.window);
    const ho = typeof startHandoff === 'function' && cur.kind === 'claude' && p >= HANDOFF_AT
      ? (cur.handoffAt ? '<span class="handoff-btn busy">Handoff running …</span>' : '<button class="handoff-btn" title="Claude writes HANDOFF.md, then a fresh tab continues from it at a fraction of the tokens">Hand off to a fresh tab</button>') : '';
    el.innerHTML = `${modelChip(cur.ctx)}<span class="ctxmeter ${ctxLevel(p)}" style="--p:${(p * 100).toFixed(1)}%"></span>Context ${Math.round(p * 100)}% · ${ctxText(cur.ctx)}${ho}`;
    el.title = `${cur.ctx.model}: what this conversation holds right now. Claude Code compacts automatically near the limit; /clear starts fresh.`;
  } else el.innerHTML = '';
}
// Model and effort of the active session, left of the context (Balazs 2026-11-16). From the last answer in the transcript.
const modelName = (m) => {
  const x = String(m || '').match(/claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/i);
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] && x[3].length < 3 ? '.' + x[3] : ''}` : String(m || '');
};
function modelChip(ctx) {
  if (!ctx?.model) return '';
  const eff = ctx.effort ? `<span class="effort ${esc(ctx.effort)}" title="Reasoning effort of the last answer">${esc(ctx.effort)}</span>` : '';
  return `<span class="model-chip" title="${esc(ctx.model)}">${esc(modelName(ctx.model))}${eff}</span>`;
}
// render() rebuilds the tabs, so the bars are put back afterwards.
let lastCount = null;
function afterRender() {
  renderContext();
  const n = state.sessions.length;
  if (lastCount !== null && n !== lastCount && typeof toggleHub === 'function') {
    if (n > lastCount && hub.open) toggleHub(false);       // a session was opened (sidebar, palette, radar card)
    else if (n === 0 && !hub.open) toggleHub(true);        // last tab closed: the hub instead of an empty screen
  }
  lastCount = n;
  if (hub.open && hub.view === 'radar' && hub.radar) renderRadar();
}
// Working tabs: refresh the active one every 15 s, so the meter moves during long turns too.
setInterval(() => { const s = byId(state.activeId); if (s && s.status === 'working') refreshContext(s); }, 15000);

// ================= Hub view: Radar + Stats =================
const hub = { open: false, view: 'radar', radar: null, radarAt: 0, range: 7, stats: null, heat: null, attention: false, sort: 'recent' };
try { hub.view = localStorage.getItem('dojo.hubView') || 'radar'; hub.sort = localStorage.getItem('dojo.hubSort') || 'recent'; } catch {}

function toggleHub(force) {
  hub.open = force ?? !hub.open;
  document.body.classList.toggle('hub-open', hub.open);
  $('#hub').classList.toggle('hidden', !hub.open);
  $('#toggle-hub').classList.toggle('on', hub.open);
  if (hub.open) showHubView(hub.view);
  else { requestAnimationFrame(refit); byId(state.activeId)?.term.focus(); }
}
// Close button and Esc lead back to the sessions (Balazs 2026-11-16). With no session open the empty start view shows.
$('#hub-close').addEventListener('click', () => toggleHub(false));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !hub.open || document.querySelector('.card-stage, #palette:not(.hidden), #settings:not(.hidden)')) return;
  e.preventDefault(); toggleHub(false);
});
// Loading skeletons (Balazs 2026-11-16): the big empty area shows what is coming while the scan runs.
// Radar: a sweeping radar plus placeholder cards. Stats: KPI tiles, an equalizer of bars, a heatmap wave, table rows.
function hubSkeleton(v) {
  const n = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join('');
  if (v === 'radar') {
    const count = state.projects.filter((p) => !meta(p).hidden).length || 12;
    return `<div class="skel" aria-label="Scanning projects">
      <div class="skel-head"><div class="radar-sweep"><i></i><b></b></div><div><div class="skel-title">Scanning ${count} projects</div><div class="skel-sub">git status, last log entry, open sessions</div></div></div>
      <div class="rgrid">${n(Math.min(count, 16), (i) => `<div class="skel-card" style="--d:${i * 60}ms"><b></b><s></s><s class="short"></s><em></em></div>`)}</div></div>`;
  }
  return `<div class="skel" aria-label="Counting tokens">
    <div class="kpis">${n(5, (i) => `<div class="kpi skel-kpi" style="--d:${i * 90}ms"><b></b><s></s></div>`)}</div>
    <div class="skel-row">
      <div class="panel grow"><div class="skel-label">Reading transcripts</div><div class="eq">${n(26, (i) => `<i style="--d:${(i * 137) % 900}ms"></i>`)}</div></div>
      <div class="panel"><div class="skel-label">Last 12 weeks</div><div class="heat skel-heat">${n(84, (i) => `<i style="--d:${Math.floor(i / 7) * 70 + (i % 7) * 20}ms"></i>`)}</div></div>
    </div>
    <div class="panel">${n(5, (i) => `<div class="skel-line" style="--d:${i * 80}ms"><s></s><s></s><s></s></div>`)}</div></div>`;
}
// When real content replaces a skeleton, it enters once with a short stagger (bars grow, cards rise).
new MutationObserver(() => {
  const body = $('#hub-body');
  if (!hub.enter || body.querySelector('.skel')) return;
  hub.enter = false;
  body.classList.add('enter');
  setTimeout(() => body.classList.remove('enter'), 900);
}).observe($('#hub-body'), { childList: true });
function showHubView(v) {
  hub.view = v;
  try { localStorage.setItem('dojo.hubView', v); } catch {}
  document.querySelectorAll('.hub-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  // Clear the other view right away: a slow scan must never leave the old view under the new tab (Balazs 2026-11-16).
  if (hub.shown !== v) { hub.shown = v; $('#hub-body').innerHTML = hubSkeleton(v); $('#hub-tools').innerHTML = ''; hub.enter = true; }
  if (v === 'radar') loadRadar(); else loadStats();
}

// ---------- radar ----------
async function loadRadar(force) {
  if (hub.radar && !force && Date.now() - hub.radarAt < 30000) return renderRadar();
  $('#hub-sub').textContent = 'Scanning projects …';
  const data = await api.radar();
  hub.radar = data;
  hub.radarAt = Date.now();
  // A slow scan must not paint over a view Balazs already switched to (radar used to overwrite stats, 2026-11-16).
  if (hub.view === 'radar' && hub.open) renderRadar();
}
function radarActivity(r) { return Math.max(r.lastChat || 0, r.logMtime || 0, r.git?.lastCommit || 0); }
function radarChips(r) {
  const c = [];
  if (r.git) {
    if (r.git.dirty) c.push(['warn', `${r.git.dirty} uncommitted`]);
    if (r.git.ahead) c.push(['warn push', `${r.git.ahead} unpushed · push`]);
    if (r.git.ahead === null) c.push(['dim', 'no remote']);
    if (!r.git.dirty && r.git.ahead === 0) c.push(['ok', 'clean']);
  } else c.push(['dim', 'no git']);
  if (!r.brain) c.push(['dim', 'no brain']);
  return c;
}
// log lines are markdown: **bold** and `code` render, the markers do not show
const mdInline = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
const needsAttention = (r, live) => live.some((s) => s.status === 'waiting' || s.status === 'approval') || !!r.git?.dirty || !!r.git?.ahead;
function renderRadar() {
  if (!hub.radar || hub.view !== 'radar') return;
  const body = $('#hub-body');
  const byPath = new Map(hub.radar.map((r) => [r.path, r]));
  let groups;
  if (hub.sort === 'category') {
    groups = groupProjects().map((g) => ({ name: g.name, items: g.projects.map((p) => byPath.get(p.path)).filter(Boolean) }));
  } else {
    const visible = hub.radar.filter((r) => { const p = state.projects.find((x) => x.path === r.path); return p && !meta(p).hidden; });
    groups = [{ name: '', items: visible.sort((a, b) => radarActivity(b) - radarActivity(a)) }];
  }
  let shown = 0, attn = 0;
  const html = groups.map((g) => {
    const cards = g.items.map((r) => {
      const p = state.projects.find((x) => x.path === r.path);
      const live = state.sessions.filter((s) => s.project.path === r.path);
      const a = needsAttention(r, live);
      if (a) attn++;
      if (hub.attention && !a) return '';
      shown++;
      const chips = radarChips(r).map(([k, t]) => `<span class="chip ${k}">${esc(t)}</span>`).join('');
      const dots = live.map((s) => `<span class="dot ${s.status}"></span>`).join('');
      const log = r.log ? `<div class="rc-log">${r.log.date ? `<span class="rc-date">${esc(r.log.date)}</span>` : ''}<span class="rc-title">${mdInline(r.log.title || '')}</span></div><div class="rc-line">${mdInline(r.log.line || '')}</div>` : '<div class="rc-line muted">No log.md yet</div>';
      const next = r.log?.next ? `<div class="rc-next"><b>Next</b> ${mdInline(r.log.next)}</div>` : '';
      return `<div class="rcard${a ? ' attn' : ''}${live.length ? ' live' : ''}" data-path="${esc(r.path)}" style="--c:${meta(p || {}).color || 'transparent'}">
        <div class="rc-top"><span class="rc-name">${esc(p ? projName(p) : r.name)}</span><span class="dots">${dots}</span><span class="rc-ago">${esc(ago(radarActivity(r)))}</span></div>
        ${log}${next}<div class="rc-chips">${chips}</div></div>`;
    }).join('');
    if (!cards) return '';
    return `${g.name ? `<div class="hub-group">${esc(g.name)}</div>` : ''}<div class="rgrid">${cards}</div>`;
  }).join('');
  body.innerHTML = html || '<div class="hub-empty">Nothing needs your attention. Clean.</div>';
  $('#hub-sub').textContent = `${shown} projects · ${attn} need attention · updated ${ago(hub.radarAt)}`;
  $('#hub-tools').innerHTML = `
    <button class="pill${hub.attention ? ' on' : ''}" data-act="attn">Needs attention</button>
    <div class="seg"><button data-sort="recent" class="${hub.sort === 'recent' ? 'active' : ''}">Recent</button><button data-sort="category" class="${hub.sort === 'category' ? 'active' : ''}">Categories</button></div>
    <button class="icon-btn" data-act="reload" title="Rescan">⟳</button>`;
  body.querySelectorAll('.rcard').forEach((el) => {
    const p = state.projects.find((x) => x.path === el.dataset.path);
    if (!p) return;
    el.addEventListener('click', () => { toggleHub(false); goToProject(p); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e, projectMenu(p)); });
  });
}

// ---------- stats ----------
async function loadStats() {
  $('#hub-sub').textContent = 'Reading transcripts …';
  $('#hub-body').classList.add('busy');
  const [st, heat] = await Promise.all([api.stats(hub.range), api.stats(84)]).finally(() => $('#hub-body').classList.remove('busy'));
  hub.stats = st; hub.heat = heat;
  if (hub.view === 'stats' && hub.open) renderStats();
  const range = hub.range;
  api.codeStats(range).then((c) => { hub.code = c; hub.codeRange = range; if (hub.view === 'stats' && hub.open && hub.range === range) renderStats(); });
}
function dayKeys(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}
function bars(series, n, key, fmt) {
  const keys = dayKeys(n);
  const vals = keys.map((k) => series[k]?.[key] || 0);
  const max = Math.max(...vals, 1e-9);
  return `<div class="bars" style="--n:${n}">${keys.map((k, i) => {
    const d = new Date(k + 'T12:00');
    const lab = n <= 7 ? d.toLocaleDateString('en', { weekday: 'short' }) : d.getDate() === 1 || i === 0 ? d.toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '';
    return `<div class="bar" title="${k}: ${fmt(vals[i])}"><i style="height:${Math.max(vals[i] ? 3 : 0, (vals[i] / max) * 100)}%"></i><span>${lab}</span></div>`;
  }).join('')}</div>`;
}
function heatmap(series) {
  const keys = dayKeys(84);
  const max = Math.max(...keys.map((k) => series[k]?.msgs || 0), 1);
  // columns = weeks, rows = weekdays (Mon top)
  const first = new Date(keys[0] + 'T12:00');
  const pad = (first.getDay() + 6) % 7;
  const cells = [...Array(pad).fill(null), ...keys];
  return `<div class="heat">${cells.map((k) => {
    if (!k) return '<i class="pad"></i>';
    const v = series[k]?.msgs || 0;
    const lvl = v ? Math.min(4, 1 + Math.floor((v / max) * 3.999)) : 0;
    return `<i class="l${lvl}" title="${k}: ${v} messages"></i>`;
  }).join('')}</div>`;
}
function renderStats() {
  const st = hub.stats;
  if (!st || hub.view !== 'stats') return;
  const code = hub.code && hub.codeRange === hub.range ? hub.code : null;
  const codeBy = new Map((code?.rows || []).map((r) => [r.path, r]));
  const t = st.total;
  const rows = [...st.rows];
  for (const c of code?.rows || []) if (c.added && !rows.some((r) => r.path === c.path)) rows.push({ name: c.name, path: c.path, msgs: 0, in: 0, cw5: 0, cw1h: 0, cr: 0, out: 0, cost: 0, activeMs: 0, sessions: 0, agents: 0, last: 0 });
  const maxTok = Math.max(...rows.map(tokSum), 1);
  const n = hub.range || 60;
  $('#hub-sub').innerHTML = `${hub.range ? `Last ${hub.range} days` : 'All time'} · ${st.files} transcripts · costs are <b>API list-price equivalent</b>, not your subscription bill`;
  $('#hub-tools').innerHTML = `
    <div class="seg">${[[7, '7 days'], [30, '30 days'], [0, 'All time']].map(([d, l]) => `<button data-range="${d}" class="${hub.range === d ? 'active' : ''}">${l}</button>`).join('')}</div>
    <button class="pill accent" data-act="card">Week card</button>`;
  $('#hub-body').innerHTML = `
    <div class="kpis">
      <div class="kpi"><b>${fmtUsd(t.cost)}</b><span>API value</span></div>
      <div class="kpi"><b>${fmtTok(tokSum(t))}</b><span>tokens (${fmtTok(t.out)} written by Claude)</span></div>
      <div class="kpi"><b>${t.sessions}</b><span>sessions</span></div>
      <div class="kpi"><b>${fmtHours(t.activeMs)}</b><span>active with Claude</span></div>
      <div class="kpi"><b>${code ? fmtLines(code.total.added) : '…'}</b><span>lines of code added${code ? ` · ${fmtLines(code.total.loc)} in the hub` : ''}</span></div>
    </div>
    <div class="stat-row">
      <div class="panel grow"><div class="panel-title">API value per day</div>${bars(st.series, n, 'cost', fmtUsd)}</div>
      <div class="panel"><div class="panel-title">Last 12 weeks</div>${heatmap(hub.heat?.series || {})}<div class="heat-legend">less <i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> more</div></div>
    </div>
    <div class="panel"><div class="panel-title">Per project</div>
      <table class="ptable"><thead><tr><th>Project</th><th class="share"></th><th>Tokens</th><th>API value</th><th>Sessions</th><th>Agents</th><th>Active</th><th title="Lines of code added in this range (git, code files only)">Code +</th><th title="Lines of code in the project now">LOC</th><th>Last</th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-path="${esc(r.path)}"><td class="pn">${esc(r.name)}</td><td class="share"><i style="width:${(tokSum(r) / maxTok) * 100}%"></i></td><td>${fmtTok(tokSum(r))}</td><td>${fmtUsd(r.cost)}</td><td>${r.sessions}</td><td>${r.agents || ''}</td><td>${fmtHours(r.activeMs)}</td><td>${codeBy.get(r.path)?.added ? `+${fmtLines(codeBy.get(r.path).added)}` : ''}</td><td class="muted">${codeBy.get(r.path) ? fmtLines(codeBy.get(r.path).loc) : ''}</td><td class="muted">${esc(ago(r.last))}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">No Claude activity in this range.</td></tr>'}
      </tbody></table>
      <div class="foot-note">Lines of code come from git (code files only, no lockfiles, minified or build output), so they include work from every machine. Sessions started outside a project (for example in your home folder) count for the hub project their tools touched most that day, otherwise for "Outside hub".</div>
    </div>`;
  $('#hub-body').querySelectorAll('tr[data-path]').forEach((tr) => {
    const p = state.projects.find((x) => x.path === tr.dataset.path);
    if (p) tr.addEventListener('click', () => { toggleHub(false); goToProject(p); });
  });
}

// ---------- week card (shareable PNG) ----------
const card = { names: true, money: true };
try { Object.assign(card, JSON.parse(localStorage.getItem('dojo.card') || '{}')); } catch {}
async function openWeekCard() {
  const [st, code] = await Promise.all([hub.range === 7 && hub.stats ? hub.stats : api.stats(7), hub.codeRange === 7 && hub.code ? hub.code : api.codeStats(7)]);
  const wrap = document.createElement('div');
  wrap.id = 'cardmodal';
  const draw = () => {
    const t = st.total;
    const top = st.rows.filter((r) => r.name !== 'Outside hub').slice(0, 5);
    const maxTok = Math.max(...top.map(tokSum), 1);
    const from = new Date(Date.now() - 6 * 86400000), to = new Date();
    const range = `${from.toLocaleDateString('en', { month: 'short', day: 'numeric' })} to ${to.toLocaleDateString('en', { month: 'short', day: 'numeric' })}`;
    wrap.innerHTML = `
      <div class="card-stage">
        <div class="wcard" id="wcard">
          <div class="wc-head"><img src="../assets/logo.svg" alt="" /><div><div class="wc-brand">DOJO</div><div class="wc-range">My week with Claude Code · ${range}</div></div></div>
          <div class="wc-kpis">
            <div><b>${t.sessions}</b><span>sessions</span></div>
            <div><b>${fmtHours(t.activeMs)}</b><span>building</span></div>
            <div><b>${fmtLines(code.total.added)}</b><span>lines of code</span></div>
            <div><b>${fmtTok(tokSum(t))}</b><span>tokens</span></div>
            ${card.money ? `<div><b>${fmtUsd(t.cost)}</b><span>API value</span></div>` : `<div><b>${st.rows.filter((r) => r.name !== 'Outside hub').length}</b><span>projects</span></div>`}
          </div>
          <div class="wc-body">
            <div class="wc-top">${top.map((r, i) => `<div class="wc-row"><span class="wc-pn">${card.names ? esc(r.name) : `Project ${String.fromCharCode(65 + i)}`}</span><span class="wc-bar"><i style="width:${(tokSum(r) / maxTok) * 100}%"></i></span><span class="wc-v">${fmtTok(tokSum(r))}</span></div>`).join('') || '<div class="muted">No project activity this week.</div>'}</div>
            <div class="wc-days">${bars(st.series, 7, 'tokens', fmtTok)}</div>
          </div>
          <div class="wc-foot"><span>Built with Claude Code</span><span>techwithbali.com</span></div>
        </div>
      </div>
      <div class="card-actions">
        <label><input type="checkbox" data-opt="names" ${card.names ? 'checked' : ''}/> Project names</label>
        <label><input type="checkbox" data-opt="money" ${card.money ? 'checked' : ''}/> API value</label>
        <span class="spacer"></span>
        <button class="pill" data-act="copy">Copy image</button>
        <button class="pill accent" data-act="save">Save PNG</button>
        <button class="pill" data-act="close">Close</button>
      </div>`;
    wrap.querySelectorAll('[data-opt]').forEach((cb) => cb.addEventListener('change', () => {
      card[cb.dataset.opt] = cb.checked;
      try { localStorage.setItem('dojo.card', JSON.stringify(card)); } catch {}
      draw();
    }));
    wrap.querySelector('[data-act="close"]').addEventListener('click', () => wrap.remove());
    for (const act of ['copy', 'save']) {
      wrap.querySelector(`[data-act="${act}"]`).addEventListener('click', async () => {
        const r = wrap.querySelector('#wcard').getBoundingClientRect();
        const z = api.zoom ? api.zoom() : 1;
        const res = await api.captureCard({ x: r.x * z, y: r.y * z, width: r.width * z, height: r.height * z }, act === 'save');
        dojoToast(res.file ? 'Saved to Pictures\\Dojo and copied' : 'Card copied to the clipboard');
      });
    }
  };
  draw();
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) wrap.remove(); });
  document.body.appendChild(wrap);
}

// hub toolbar clicks (delegated, the toolbar is re-rendered)
$('#hub-tools').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.range !== undefined) { hub.range = Number(b.dataset.range); loadStats(); }
  else if (b.dataset.sort) { hub.sort = b.dataset.sort; try { localStorage.setItem('dojo.hubSort', hub.sort); } catch {} renderRadar(); }
  else if (b.dataset.act === 'attn') { hub.attention = !hub.attention; renderRadar(); }
  else if (b.dataset.act === 'reload') loadRadar(true);
  else if (b.dataset.act === 'card') openWeekCard();
});
document.querySelectorAll('.hub-tabs button').forEach((b) => b.addEventListener('click', () => showHubView(b.dataset.view)));
$('#toggle-hub').addEventListener('click', () => toggleHub());
$('#empty-open-hub')?.addEventListener('click', () => toggleHub(true));

// ================= Brain panel =================
const bp = { open: false, files: [], sel: null, diff: false, dir: null };
try { bp.open = localStorage.getItem('dojo.brain') === '1'; } catch {}
function toggleBrain(force) {
  bp.open = force ?? !bp.open;
  try { localStorage.setItem('dojo.brain', bp.open ? '1' : '0'); } catch {}
  document.body.classList.toggle('brain-open', bp.open);
  $('#brain').classList.toggle('hidden', !bp.open);
  document.querySelectorAll('.brain-btn').forEach((b) => b.classList.toggle('on', bp.open));
  if (bp.open) refreshBrain(true);
  requestAnimationFrame(refit);
}
async function refreshBrain(force) {
  if (!bp.open) return;
  const s = byId(state.activeId);
  const dir = s ? s.project.path : state.projects.find((p) => p.isHub)?.path;
  if (!dir) return;
  if (dir !== bp.dir) { bp.dir = dir; bp.sel = null; bp.diff = false; }
  else if (!force) return;
  bp.files = await api.brainFiles(dir);
  if (!bp.sel) bp.sel = bp.files.find((f) => f.rel === 'CLAUDE.md')?.rel || bp.files[0]?.rel || null;
  renderBrain();
}
function renderBrain() {
  const s = byId(state.activeId);
  const since = s?.startedAt || Date.now();
  const proj = s ? projName(s.project) : 'Hub';
  $('#brain-proj').textContent = proj;
  const changed = bp.files.filter((f) => f.mtime > since);
  const groups = [['Core', (f) => !f.rel.includes('/')], ['Topics', (f) => f.rel.startsWith('topics/')], ['Learnings', (f) => f.rel.startsWith('learnings/')], ['Reference', (f) => f.rel.startsWith('reference/')]];
  $('#brain-summary').innerHTML = !bp.files.length ? 'No brain files in this folder.'
    : changed.length ? `<b>${changed.length}</b> ${changed.length === 1 ? 'file' : 'files'} changed in this session` : 'No brain changes in this session yet';
  $('#brain-list').innerHTML = groups.map(([name, fn]) => {
    const fs = bp.files.filter(fn);
    if (!fs.length) return '';
    return `<div class="bl-group">${name}</div>${fs.map((f) => `<div class="bl-item${f.rel === bp.sel ? ' sel' : ''}${f.mtime > since ? ' changed' : ''}" data-rel="${esc(f.rel)}"><span>${esc(f.rel.split('/').pop())}</span>${f.mtime > since ? '<em>changed</em>' : `<small>${esc(ago(f.mtime))}</small>`}</div>`).join('')}`;
  }).join('');
  $('#brain-list').querySelectorAll('.bl-item').forEach((el) => el.addEventListener('click', () => { bp.sel = el.dataset.rel; bp.diff = false; renderBrain(); }));
  renderBrainView(since);
  const wrapBtn = $('#brain-wrap');
  const can = s && s.kind === 'claude' && !s.dead && s.status !== 'working';
  wrapBtn.disabled = !can;
  wrapBtn.title = !s ? 'Open a Claude session first' : s.kind !== 'claude' ? 'Only in Claude tabs' : s.status === 'working' ? 'Wait until Claude is done' : 'Types /log into this session: Claude writes the log entry and commits';
}
async function renderBrainView(since) {
  const view = $('#brain-view');
  const f = bp.files.find((x) => x.rel === bp.sel);
  if (!f) { view.innerHTML = ''; return; }
  const isChanged = f.mtime > since;
  const head = `<div class="bv-head"><span>${esc(f.rel)}</span>${isChanged ? `<button class="pill small${bp.diff ? ' on' : ''}" id="bv-diff">${bp.diff ? 'Show file' : 'Show changes'}</button>` : ''}<button class="icon-btn" id="bv-open" title="Open in editor">↗</button></div>`;
  let content;
  if (bp.diff) {
    const d = await api.brainDiff(bp.dir, f.rel);
    content = d ? `<pre class="diff">${esc(d).split('\n').map((l) => `<span class="${l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}">${l}</span>`).join('\n')}</pre>`
      : '<div class="muted pad">No uncommitted changes (already committed, or the folder is not a git repo).</div>';
  } else content = `<div class="md">${miniMarkdown((await api.brainRead(bp.dir, f.rel)) || '')}</div>`;
  view.innerHTML = head + content;
  view.querySelector('#bv-diff')?.addEventListener('click', () => { bp.diff = !bp.diff; renderBrainView(since); });
  view.querySelector('#bv-open').addEventListener('click', () => api.fsOpen(IS_MAC ? `${bp.dir}/${f.rel}` : `${bp.dir}\\${f.rel.replace(/\//g, '\\')}`));
}
// Small, safe markdown: headings, bullets, code blocks, inline code, bold, @imports. Everything is escaped first.
function miniMarkdown(src) {
  const lines = src.replace(/\r/g, '').split('\n');
  let out = '', inCode = false, inList = false;
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|\s)(@topics\/[\w.-]+)/g, '$1<span class="imp">$2</span>');
  for (const l of lines) {
    if (l.trim().startsWith('```')) { if (inList) { out += '</ul>'; inList = false; } out += inCode ? '</pre>' : '<pre>'; inCode = !inCode; continue; }
    if (inCode) { out += esc(l) + '\n'; continue; }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    const li = l.match(/^\s*[-*]\s+(.*)/);
    if (!li && inList) { out += '</ul>'; inList = false; }
    if (h) out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    else if (li) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${inline(li[1])}</li>`; }
    else if (l.trim()) out += `<p>${inline(l)}</p>`;
  }
  if (inList) out += '</ul>';
  if (inCode) out += '</pre>';
  return out;
}
$('#brain-close').addEventListener('click', () => toggleBrain(false));
// Refresh buttons give visible feedback (Balazs 2026-11-16: "is this button even working?"): the icon spins at least
// one full turn (700 ms), then a short pill says what happened ("Up to date", "1 file changed") and fades out.
async function refreshFeedback(btn, work) {
  if (btn.classList.contains('spinning')) return;
  btn.classList.add('spinning');
  const slow = setTimeout(() => btn.classList.add('slow'), 700);
  const [msg] = await Promise.all([work().catch(() => 'Refresh failed'), new Promise((r) => setTimeout(r, 700))]);
  clearTimeout(slow);
  btn.classList.remove('spinning', 'slow');
  btn.parentElement.querySelector('.refresh-note')?.remove();
  const note = document.createElement('span');
  note.className = 'refresh-note' + (/fail/i.test(msg) ? ' bad' : /changed|new/.test(msg) ? ' news' : '');
  note.innerHTML = (/fail/i.test(msg) ? '' : '<svg viewBox="0 0 16 16" width="11" height="11"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>') + esc(msg);
  btn.before(note);
  setTimeout(() => note.classList.add('out'), 2200);
  setTimeout(() => note.remove(), 2700);
}
$('#brain-refresh').addEventListener('click', (e) => refreshFeedback(e.currentTarget, async () => {
  const before = new Map(bp.files.map((f) => [f.rel, f.mtime]));
  await refreshBrain(true);
  const changed = bp.files.filter((f) => before.get(f.rel) !== f.mtime).length;
  return changed ? `${changed} ${changed === 1 ? 'file' : 'files'} changed` : 'Up to date';
}));
$('#toggle-brain').addEventListener('click', () => toggleBrain());
$('#brain-wrap').addEventListener('click', () => {
  const s = byId(state.activeId);
  if (!s || s.kind !== 'claude' || s.status === 'working') return;
  // Typed like a person: text first, Enter a moment later, so Claude's input box takes it as one command.
  api.write(s.id, '/log');
  setTimeout(() => api.write(s.id, '\r'), 180);
  s.term.focus();
  dojoToast('Sent /log: Claude writes the log entry and commits');
});
if (bp.open) setTimeout(() => toggleBrain(true), 0);

// ================= new projects (additive only, never renames or deletes) =================
function newProjectFlow(at, template, category) {
  promptText(at, '', template ? 'Name of the new project (copies _TEMPLATE)' : 'Name of the new project folder', async (v) => {
    if (!v) return;
    const r = await api.createProject(v, template);
    if (r.error) return flash(r.error);
    state.projects = await api.listProjects();
    const p = state.projects.find((x) => x.path === r.path);
    if (!p) return flash('Folder created, but Dojo could not find it');
    if (category && category !== 'Other') moveProject(p, category); else renderProjects();
    dojoToast(r.template ? `Created "${v}" with the brain template` : `Created folder "${v}"`);
    openSession(p, 'claude', false); // a new project's first step is a Claude session that fills the brain
  });
}
function addProjectMenu(category) {
  const hidden = state.projects.filter((p) => meta(p).hidden);
  return [
    { label: 'New project with brain template …', action: () => newProjectFlow(e0, true, category) },
    { label: 'New empty project folder …', action: () => newProjectFlow(e0, false, category) },
    '-',
    { label: `Show removed projects (${hidden.length})`, disabled: !hidden.length, action: () => hidden.forEach((p) => setProjectMeta(p, { hidden: '' })) },
    { label: 'Open hub folder in Explorer', action: () => api.openFolder(state.projects.find((p) => p.isHub)?.path) },
  ];
}
$('#proj-add').addEventListener('click', (e) => { e.stopPropagation(); showMenu(e, addProjectMenu(null)); });

// Boot may have finished before this file loaded: then the hub check from the boot never ran.
if (state.booted) { lastCount = state.sessions.length; renderContext(); if (!state.sessions.length && !hub.open) toggleHub(true); }
