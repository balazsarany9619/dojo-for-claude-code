// Dojo insights (2026-11-16): usage stats, context per tab, hub radar, brain panel, new projects.
// Everything here only READS the disk, except createProject (adds a folder, never touches existing ones).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const convFolder = (dir) => path.join(CLAUDE_PROJECTS, dir.replace(/[^a-zA-Z0-9]/g, '-'));

// ---------- prices (API list prices per 1M tokens, checked 2026-11-16 against the claude-api skill) ----------
// Claude Code writes 1h cache entries; 1h cache write = 2x input, 5m = 1.25x input. On a subscription this is the
// API-equivalent value, not what Balazs pays. Unknown models count tokens but no cost.
const PRICES = [
  [/opus-5-5/, { in: 4, out: 20, cr: 0.2 }],
  [/opus-5(?!-5)|opus-4-[678]/, { in: 5, out: 25, cr: 0.5 }],
  [/sonnet-5-5/, { in: 2, out: 10, cr: 0.1 }],
  [/sonnet-5(?!-5)/, { in: 2, out: 10, cr: 0.2 }],
  [/sonnet-4/, { in: 3, out: 15, cr: 0.3 }],
  [/haiku-5-5/, { in: 0.1, out: 0.5, cr: 0.01 }],
  [/haiku-4/, { in: 1, out: 5, cr: 0.1 }],
  [/fable-5-2|mythos-5-2/, { in: 8, out: 40, cr: 0.2 }],
  [/fable|mythos/, { in: 10, out: 50, cr: 1 }],
];
const priceOf = (model) => (PRICES.find(([re]) => re.test(model || '')) || [])[1] || null;
function costOf(model, u) {
  const p = priceOf(model);
  if (!p) return 0;
  return (u.in * p.in + u.cw5 * p.in * 1.25 + u.cw1h * p.in * 2 + u.cr * p.cr + u.out * p.out) / 1e6;
}
// Context window per model: the Claude 4.6+ and 5 families have 1M, Haiku 4.5 and older 200K.
const windowOf = (model) => (/haiku-4|-3-|claude-3|sonnet-4-5|opus-4-5/.test(model || '') ? 200000 : 1000000);

// ---------- transcript scan (cached per file by size + mtime) ----------
function listTranscripts() {
  const out = [];
  const walk = (dir, depth) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      const p = path.join(dir, d.name);
      if (d.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (d.isFile() && d.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(CLAUDE_PROJECTS, 0);
  return out;
}

const dayOf = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// "Claude Code Projects" + any run of slashes/backslashes (JSON escapes them) + the hub folder name.
let MENTION = /Claude Code Projects[\\/]+([^\\/"]+)/g;
// One file -> { cwd, days: { 'YYYY-MM-DD': { msgs, in, cw5, cw1h, cr, out, cost, activeMs } }, mentions, first, last, sub }
function scanFile(file) {
  const res = { cwd: '', days: {}, mentions: {}, first: 0, last: 0, sub: file.includes(`${path.sep}subagents${path.sep}`) };
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return res; }
  const seen = new Set();
  let prev = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    // cheap filter before JSON.parse: most lines are tool results and attachments without usage
    const hasUsage = line.includes('"usage"');
    const hasTs = line.includes('"timestamp"');
    if (!hasUsage && !hasTs) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!res.cwd && e.cwd) res.cwd = e.cwd;
    const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
    if (ts) {
      if (!res.first) res.first = ts;
      res.last = ts;
      if (prev && ts > prev) {
        const gap = ts - prev;
        if (gap < 5 * 60 * 1000) { const d = (res.days[dayOf(ts)] ||= blank()); d.activeMs += gap; }
      }
      prev = ts;
    }
    const m = e.message;
    if (e.type === 'assistant' && line.includes('"tool_use"')) {
      // Sessions started outside a project (e.g. the home folder) are attributed by the hub folders their tools touch.
      const day = dayOf(ts || res.last || Date.now());
      for (const mm of line.matchAll(MENTION)) { const d = (res.mentions[day] ||= {}); d[mm[1]] = (d[mm[1]] || 0) + 1; }
    }
    if (e.type !== 'assistant' || !m?.usage || !m.model || m.model === '<synthetic>') continue;
    if (m.id && seen.has(m.id)) continue; // streaming writes the same message several times with the same usage
    if (m.id) seen.add(m.id);
    const u = m.usage, cc = u.cache_creation || {};
    const cw1h = cc.ephemeral_1h_input_tokens ?? 0;
    const cw5 = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - cw1h);
    const t = { in: u.input_tokens || 0, cw5, cw1h, cr: u.cache_read_input_tokens || 0, out: u.output_tokens || 0 };
    const d = (res.days[dayOf(ts || res.last || Date.now())] ||= blank());
    d.msgs++; d.in += t.in; d.cw5 += t.cw5; d.cw1h += t.cw1h; d.cr += t.cr; d.out += t.out; d.cost += costOf(m.model, t);
    d.models[m.model] = (d.models[m.model] || 0) + 1;
  }
  return res;
}
function blank() { return { msgs: 0, in: 0, cw5: 0, cw1h: 0, cr: 0, out: 0, cost: 0, activeMs: 0, models: {} }; }

let cacheFile = null, cache = null;
function loadCache(userData) {
  if (cache) return cache;
  cacheFile = path.join(userData, 'stats-cache.json');
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (cache.v !== 3) cache = null; } catch { cache = null; }
  return (cache ||= { v: 3, files: {} });
}

// Scans changed files only. Yields to the event loop between files so the window stays responsive.
async function scanAll(userData) {
  const c = loadCache(userData);
  const files = listTranscripts();
  const alive = new Set(files);
  for (const f of Object.keys(c.files)) if (!alive.has(f)) delete c.files[f];
  let changed = 0;
  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    const key = `${st.size}:${Math.round(st.mtimeMs)}`;
    if (c.files[f]?.key === key) continue;
    c.files[f] = { key, ...scanFile(f) };
    changed++;
    await new Promise((r) => setImmediate(r));
  }
  if (changed) try { fs.writeFileSync(cacheFile, JSON.stringify(c)); } catch {}
  return c;
}

// Attribute a cwd to the project whose path is its longest prefix (subfolders count for the project).
function attribute(cwd, projects) {
  const norm = (p) => p.replace(/[\\/]+$/, '').toLowerCase();
  const c = norm(cwd || '');
  let best = null;
  for (const p of projects) {
    if (p.isHub) continue;
    const pp = norm(p.path);
    if ((c === pp || c.startsWith(pp + path.sep.toLowerCase()) || c.startsWith(pp + '/')) && (!best || pp.length > norm(best.path).length)) best = p;
  }
  return best;
}

// Totals per project for the last `days` days (0 = all time), plus a per-day series for the heatmap.
async function stats(userData, projects, days = 7) {
  // Mentions follow the hub's folder name, so the attribution works for any hub, not only "Claude Code Projects".
  const hubDir = projects.find((p) => p.isHub)?.path;
  if (hubDir) {
    const name = path.basename(hubDir).replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
    MENTION = new RegExp(name + '[\\\\/]+([^\\\\/"]+)', 'g');
  }
  const c = await scanAll(userData);
  const since = days ? dayOf(Date.now() - (days - 1) * 86400000) : '0000';
  const per = new Map();
  const series = {};
  const total = { ...blank(), sessions: 0 };
  for (const [file, r] of Object.entries(c.files)) {
    const own = attribute(r.cwd, projects);
    const touchedBy = new Set();
    for (const [day, d] of Object.entries(r.days)) {
      if (day < since) continue;
      let p = own;
      if (!p) { // outside every project: the hub folder this day's tool calls touched most (at least 3 times)
        const top = Object.entries(r.mentions?.[day] || {}).sort((a, b) => b[1] - a[1])[0];
        if (top && top[1] >= 3) p = projects.find((x) => x.name.toLowerCase() === top[0].toLowerCase()) || null;
      }
      const name = p ? p.name : 'Outside hub';
      if (d.msgs) touchedBy.add(name);
      const row = per.get(name) || { name, path: p?.path || '', ...blank(), sessions: 0, agents: 0, last: 0 };
      for (const k of ['msgs', 'in', 'cw5', 'cw1h', 'cr', 'out', 'cost', 'activeMs']) { row[k] += d[k]; total[k] += d[k]; }
      for (const [m, n] of Object.entries(d.models)) { row.models[m] = (row.models[m] || 0) + n; total.models[m] = (total.models[m] || 0) + n; }
      row.last = Math.max(row.last, r.last);
      per.set(name, row);
      const s = (series[day] ||= { cost: 0, tokens: 0, msgs: 0 });
      s.cost += d.cost; s.tokens += d.in + d.cw5 + d.cw1h + d.cr + d.out; s.msgs += d.msgs;
    }
    for (const name of touchedBy) { const row = per.get(name); if (r.sub) row.agents++; else row.sessions++; }
    if (touchedBy.size && !r.sub) total.sessions++;
  }
  const rows = [...per.values()].filter((r) => r.msgs).sort((a, b) => b.cost - a.cost);
  return { days, since, rows, total, series, files: Object.keys(c.files).length };
}

// ---------- context of one tab: the last assistant message's input side is what Claude currently holds ----------
function context(dir, cid) {
  if (!cid) return null;
  const file = path.join(convFolder(dir), `${cid}.jsonl`);
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, 2 * 1024 * 1024);
    buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
  } catch { return null; }
  const lines = buf.toString('utf8').split('\n');
  // A /model or /effort switch after the last answer wins right away (Balazs 2026-11-16: the chip lagged one answer).
  let newModel = '', newEffort = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.includes('local-command-stdout')) {
      const mm = l.match(/Set model to `?([^`<\\]+?)`? and/);
      if (mm && !newModel) newModel = mm[1].trim();
      const em = l.match(/effort[^<\\]*?\b(low|medium|high|xhigh|max)\b/i);
      if (em && !newEffort) newEffort = em[1].toLowerCase();
      continue;
    }
    if (!l.includes('"usage"')) continue;
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    const m = e.message;
    if (e.type !== 'assistant' || !m?.usage || m.model === '<synthetic>') continue;
    const u = m.usage;
    const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
    // effort: Claude Code writes the reasoning effort of each turn on the assistant line (perTurnEffort, else effort).
    return { used, window: windowOf(m.model), model: newModel || m.model, effort: newEffort || e.perTurnEffort || e.effort || '', switched: !!(newModel || newEffort) };
  }
  return null;
}

// ---------- lines of code per project, from git (2026-11-16) ----------
// Git, not transcripts: transcripts miss work from the Mac and files written by scripts (about 10k lines here).
// Code files only; lockfiles, minified files and build output do not count.
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|css|scss|html|gd|gdshader|lua|luau|sh|ps1|go|rs|swift|kt|sql|vue|svelte|c|cpp|h|cs|java|rb|php)$/i;
const NOT_CODE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.min\.(js|css)$|(^|\/)(dist|build|vendor|node_modules|\.expo|out|coverage)\//i;
const isCode = (f) => CODE_EXT.test(f) && !NOT_CODE.test(f.replace(/\\/g, '/'));
const locCache = new Map(); // dir -> { head, loc, files }
async function codeOne(p, days) {
  if (!fs.existsSync(path.join(p.path, '.git'))) return null;
  const since = days ? ['--since', new Date(Date.now() - days * 86400000).toISOString()] : [];
  const [log, head] = await Promise.all([
    runBig('git', ['log', '--numstat', '--format=', '--no-renames', ...since], p.path),
    run('git', ['rev-parse', 'HEAD'], p.path),
  ]);
  let added = 0, deleted = 0;
  for (const l of (log || '').split('\n')) {
    const m = l.match(/^(\d+)\t(\d+)\t(.+)$/); // binary files show "-"
    if (m && isCode(m[3])) { added += +m[1]; deleted += +m[2]; }
  }
  let cached = locCache.get(p.path);
  if (!cached || cached.head !== head) {
    const ls = await runBig('git', ['ls-files'], p.path);
    let loc = 0, files = 0;
    for (const f of (ls || '').split('\n').filter((x) => x && isCode(x))) {
      try {
        const full = path.join(p.path, f);
        if (fs.statSync(full).size > 2 * 1024 * 1024) continue;
        loc += fs.readFileSync(full, 'utf8').split('\n').length;
        files++;
      } catch {}
    }
    cached = { head, loc, files };
    locCache.set(p.path, cached);
  }
  return { name: p.name, path: p.path, added, deleted, loc: cached.loc, files: cached.files };
}
const runBig = (cmd, args, cwd) => new Promise((res) => {
  execFile(cmd, args, { cwd, timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, out) => res(err ? null : String(out)));
});
async function codeStats(projects, days) {
  const rows = (await Promise.all(projects.filter((p) => !p.isHub).map((p) => codeOne(p, days)))).filter(Boolean);
  const total = rows.reduce((t, r) => ({ added: t.added + r.added, deleted: t.deleted + r.deleted, loc: t.loc + r.loc }), { added: 0, deleted: 0, loc: 0 });
  return { rows, total };
}

// ---------- first prompt of a conversation, for automatic tab names (2026-11-16) ----------
// First real user text: skips meta lines, command wrappers (<command-name> ...), hook output and tool results.
function firstPrompt(dir, cid) {
  let text;
  try {
    const fd = fs.openSync(path.join(convFolder(dir), `${cid}.jsonl`), 'r');
    const buf = Buffer.alloc(512 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.toString('utf8', 0, n);
  } catch { return null; }
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'user' || e.isMeta) continue;
    const c = e.message?.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join(' ') : '';
    const clean = t.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean && !clean.startsWith('<') && !clean.startsWith('Caveat:')) return clean.slice(0, 300);
  }
  return null;
}

// ---------- hub radar ----------
const run = (cmd, args, cwd) => new Promise((res) => {
  execFile(cmd, args, { cwd, timeout: 4000, windowsHide: true }, (err, out) => res(err ? null : String(out)));
});
function lastLogEntry(dir) {
  let text; try { text = fs.readFileSync(path.join(dir, 'log.md'), 'utf8').slice(0, 20000).replace(/\r/g, ''); } catch { return null; }
  const m = text.match(/^##\s+(.+)$/m);
  if (!m) return null;
  const head = m[1].trim();
  const dm = head.match(/^(\d{4}-\d{2}-\d{2})\s*[:\-–]?\s*(.*)$/);
  const after = text.slice(m.index + m[0].length).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  const next = text.match(/^\s*-\s*(?:Next|OPEN|TODO)\s*:\s*(.+)$/im);
  return { date: dm ? dm[1] : '', title: dm ? dm[2] : head, line: after ? after.replace(/^[-*]\s*/, '').slice(0, 220) : '', next: next ? next[1].slice(0, 200) : '' };
}
function lastConversation(dir) {
  let best = 0;
  const base = convFolder(dir);
  try {
    for (const name of fs.readdirSync(CLAUDE_PROJECTS)) {
      if (name !== path.basename(base) && !name.startsWith(path.basename(base) + '-')) continue;
      for (const f of fs.readdirSync(path.join(CLAUDE_PROJECTS, name))) {
        if (f.endsWith('.jsonl')) best = Math.max(best, fs.statSync(path.join(CLAUDE_PROJECTS, name, f)).mtimeMs);
      }
    }
  } catch {}
  return best;
}
async function radarOne(p) {
  const isRepo = fs.existsSync(path.join(p.path, '.git'));
  let git = null;
  if (isRepo) {
    const [st, ahead, lastCommit] = await Promise.all([
      run('git', ['status', '--porcelain'], p.path),
      run('git', ['rev-list', '--count', '@{u}..HEAD'], p.path),
      run('git', ['log', '-1', '--format=%ct'], p.path),
    ]);
    git = {
      dirty: st == null ? null : st.split('\n').filter(Boolean).length,
      ahead: ahead == null ? null : Number(ahead.trim()) || 0, // null = no upstream
      lastCommit: lastCommit ? Number(lastCommit.trim()) * 1000 : 0,
    };
  }
  let logMtime = 0; try { logMtime = fs.statSync(path.join(p.path, 'log.md')).mtimeMs; } catch {}
  return { path: p.path, name: p.name, brain: p.brain, log: lastLogEntry(p.path), logMtime, lastChat: lastConversation(p.path), git };
}
async function radar(projects) {
  return Promise.all(projects.filter((p) => !p.isHub).map(radarOne));
}

// ---------- brain panel ----------
const BRAIN_DIRS = ['topics', 'learnings', 'reference'];
function brainFiles(dir) {
  const out = [];
  const add = (rel) => { try { const st = fs.statSync(path.join(dir, rel)); if (st.isFile()) out.push({ rel, mtime: st.mtimeMs, size: st.size }); } catch {} };
  add('CLAUDE.md'); add('AGENT.md'); add('log.md');
  for (const d of BRAIN_DIRS) {
    try { for (const f of fs.readdirSync(path.join(dir, d))) if (f.endsWith('.md')) add(`${d}/${f}`); } catch {}
  }
  return out;
}
function brainRead(dir, rel) {
  const full = path.resolve(dir, rel);
  if (!full.toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep.toLowerCase()) || !full.endsWith('.md')) return null;
  try { return fs.readFileSync(full, 'utf8').slice(0, 200000); } catch { return null; }
}
async function brainDiff(dir, rel) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  return run('git', ['diff', '--no-color', '--unified=1', '--', rel], dir);
}

// ---------- new project in the hub: additive only, refuses an existing name ----------
function createProject(hub, name, withTemplate) {
  const clean = String(name || '').trim();
  if (!clean || /[<>:"/\\|?*\x00-\x1f]/.test(clean) || clean.startsWith('.') || clean.startsWith('_')) return { error: 'Invalid folder name' };
  const target = path.join(hub, clean);
  if (fs.existsSync(target)) return { error: 'A folder with this name exists already' };
  try {
    fs.mkdirSync(target);
    const tpl = path.join(hub, '_TEMPLATE');
    if (withTemplate && fs.existsSync(tpl)) fs.cpSync(tpl, target, { recursive: true, errorOnExist: true, force: false });
    return { path: target, template: withTemplate && fs.existsSync(tpl) };
  } catch (err) { return { error: err.message }; }
}

module.exports = { codeStats, firstPrompt, stats, context, radar, brainFiles, brainRead, brainDiff, createProject, windowOf, costOf };
