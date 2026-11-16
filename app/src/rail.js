// Dojo scroll rail: a bar on the right of every pane to move fast through long output (Balazs 2026-11-11).
// Two modes, picked per frame from the active buffer:
//  direct: plain terminal history (shell tabs, Claude without fullscreen). The thumb IS the position, drag = jump there.
//  jog:    Claude Code in fullscreen (alternate screen). Claude keeps the history itself and does not tell anyone how long
//          it is, so the thumb is a jog handle: pull it away and Dojo scrolls, the further you pull the faster. It springs
//          back when you let go. Its resting place is an estimate from the wheel steps Dojo has seen.
// Verified against Claude Code 2.1.322: wheel events, PageUp/PageDown and Ctrl+Home / Ctrl+End all scroll its view.
const RAIL_KEYS = { top: '\x1b[1;5H', bottom: '\x1b[1;5F', pageUp: '\x1b[5~', pageDown: '\x1b[6~' };
const RAIL_PAGE_STEPS = 12; // our estimate of wheel steps per PageUp, only used for the thumb's resting place
// Jog mode maps the track linearly onto RAIL_RANGE wheel steps: thumb at the bottom = newest output, at the top = 300 steps up.
// Dragging scrolls at once and evenly with the hand (Balazs 2026-11-11: "wenn man sie zieht passiert eine Zeit nichts").
const RAIL_RANGE = 300;
const RAIL_EDGE_RATE = 2; // wheel steps per 16 ms while the pointer is held past the top or bottom end

function railMode(s) { return s.term.buffer.active.type === 'alternate' ? 'jog' : 'direct'; }

function attachRail(s) {
  const rail = document.createElement('div');
  rail.className = 'rail';
  rail.innerHTML = '<button class="rail-btn" data-go="top" title="Jump to the start (⌘↑)">▲</button><div class="rail-track"><div class="rail-thumb"></div></div><button class="rail-btn" data-go="bottom" title="Jump to the latest output (⌘↓)">▼</button>';
  s.pane.querySelector('.term').appendChild(rail);
  s.rail = rail;
  s.jogOffset = 0; // wheel steps away from the bottom (estimate, jog mode only)
  const track = rail.querySelector('.rail-track'), thumb = rail.querySelector('.rail-thumb');

  // Count every wheel step that reaches this pane (trackpad, mouse and our own jog events) for the estimate.
  s.pane.addEventListener('wheel', (e) => {
    if (railMode(s) !== 'jog') return;
    s.jogOffset = Math.max(0, (s.jogOffset === Infinity ? 400 : s.jogOffset) + (e.deltaY < 0 ? 1 : -1));
    railUpdate(s);
  }, { capture: true, passive: true });

  rail.querySelectorAll('.rail-btn').forEach((b) => b.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    railJump(s, b.dataset.go);
  }));

  // Click on the empty track: one page towards the click.
  track.addEventListener('mousedown', (e) => {
    if (e.target === thumb) return;
    e.preventDefault(); e.stopPropagation();
    const r = thumb.getBoundingClientRect();
    railPage(s, e.clientY < r.top ? -1 : 1);
  });

  thumb.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    thumb.classList.add('drag');
    const mode = railMode(s);
    const tr = track.getBoundingClientRect();
    const y0 = e.clientY, top0 = thumb.offsetTop;
    let y = y0, timer = null;
    // jog: every pixel of thumb travel = a fixed number of wheel steps, sent at once (no dead zone, no acceleration)
    const span = Math.max(1, tr.height - thumb.offsetHeight);
    let sent = 0, edge = 0;
    const jogTo = () => {
      const raw = top0 + (y - y0);
      const top = Math.min(span, Math.max(0, raw));
      thumb.style.top = `${top}px`;
      const want = Math.round(((top0 - top) / span) * RAIL_RANGE); // steps up (+) or down (-) since the grab
      const d = want - sent;
      if (d) { railWheel(s, d > 0 ? -1 : 1, Math.abs(d)); sent = want; }
      edge = raw < 0 ? -1 : raw > span ? 1 : 0; // held past an end: keep scrolling at a steady pace
    };
    if (mode === 'jog') timer = setInterval(() => { if (edge) railWheel(s, edge, RAIL_EDGE_RATE); }, 16);
    const move = (ev) => {
      y = ev.clientY;
      if (mode === 'direct') {
        const frac = Math.min(1, Math.max(0, (top0 + (y - y0)) / span));
        s.term.scrollToLine(Math.round(frac * s.term.buffer.active.baseY));
      } else jogTo();
    };
    const up = () => {
      clearInterval(timer);
      thumb.classList.remove('drag');
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      railUpdate(s);
      s.term.focus();
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  });

  s.term.onScroll(() => railUpdate(s));
  s.term.onWriteParsed(() => { if (!s.railQueued) { s.railQueued = true; requestAnimationFrame(() => { s.railQueued = false; railUpdate(s); }); } });
  railUpdate(s);
}

// Synthetic wheel events go through xterm, which turns them into mouse reports for Claude (or scrolls its own buffer).
function railWheel(s, dir, n) {
  const el = s.pane.querySelector('.xterm-screen') || s.pane.querySelector('.xterm');
  if (!el) return;
  const r = el.getBoundingClientRect();
  for (let i = 0; i < n; i++) {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: dir * 100, deltaMode: 0, clientX: r.left + 40, clientY: r.top + 40, bubbles: true, cancelable: true }));
  }
}

function railJump(s, where) {
  if (railMode(s) === 'direct') { where === 'top' ? s.term.scrollToTop() : s.term.scrollToBottom(); return; }
  if (s.kind === 'claude') api.write(s.id, RAIL_KEYS[where]);
  else railWheel(s, where === 'top' ? -1 : 1, 60);
  s.jogOffset = where === 'top' ? Infinity : 0;
  railUpdate(s);
}

function railPage(s, dir) {
  if (railMode(s) === 'direct') { s.term.scrollPages(dir); return; }
  api.write(s.id, dir < 0 ? RAIL_KEYS.pageUp : RAIL_KEYS.pageDown);
  s.jogOffset = Math.max(0, (s.jogOffset === Infinity ? 400 : s.jogOffset) - dir * RAIL_PAGE_STEPS);
  railUpdate(s);
}

// Typing or sending a prompt brings Claude back to the newest output.
function railAtBottom(s) { if (s.jogOffset) { s.jogOffset = 0; railUpdate(s); } }

function railUpdate(s) {
  const rail = s.rail;
  if (!rail || !rail.isConnected) return;
  const thumb = rail.querySelector('.rail-thumb');
  if (thumb.classList.contains('drag') && railMode(s) === 'jog') return; // the hand holds it
  const track = rail.querySelector('.rail-track');
  const H = track.clientHeight;
  if (!H) return;
  const mode = railMode(s);
  rail.dataset.mode = mode;
  let size, frac;
  if (mode === 'direct') {
    const b = s.term.buffer.active, total = b.baseY + s.term.rows;
    size = Math.max(28, Math.round(H * (s.term.rows / total)));
    frac = b.baseY ? b.viewportY / b.baseY : 1;
    rail.classList.toggle('idle', !b.baseY);
  } else {
    size = 46;
    const o = s.jogOffset;
    frac = o === Infinity ? 0 : 1 - Math.min(1, o / RAIL_RANGE); // linear, the same scale as dragging
    rail.classList.remove('idle');
  }
  thumb.style.height = `${size}px`;
  thumb.style.top = `${Math.round((H - size) * frac)}px`;
  rail.classList.toggle('scrolled', frac < 0.98);
}
function railUpdateAll() { for (const s of state.sessions) railUpdate(s); }
new ResizeObserver(() => railUpdateAll()).observe(document.getElementById('stage'));
