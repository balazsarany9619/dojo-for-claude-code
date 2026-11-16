// Dojo startup animation (Balazs 2026-11-11: a katana blade cutting through the screen, matrix code. Wind removed on his request).
// Timeline (about 2.6 s, click or any key skips):
//   0.00  code rain in neon blue (katakana, digits, code tokens) on the dark Dojo background
//   0.90  the rain dims so the logo stands out
//   1.20  torii logo and DOJO fade in at the centre
//   1.45  the katana cut: a white-blue blade runs diagonally across the screen, sparks, short flash
//   1.80  the picture splits along the cut, both halves slide apart and reveal the app
// Loaded right after settings.js so it covers the window while the app boots. Off switch: Settings > Appearance.
(() => {
  let off = false;
  try { off = localStorage.getItem('dojo.splash') === 'off'; } catch {}
  window.playSplash = startSplash;
  if (!off) startSplash();

  function startSplash() {
    if (document.getElementById('splash')) return;
    const cv = document.createElement('canvas');
    cv.id = 'splash';
    document.body.appendChild(cv);
    const ctx = cv.getContext('2d');
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    let W = 0, H = 0;
    const size = () => { W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    size();

    const BG = '#050a18';
    const GLYPHS = 'アカサタナハマヤラワイキシチニヒミリヰウクスツヌフムユルエケセテネヘメレオコソトノホモヨロヲ0123456789{}[]<>/=+*;:$#&|~λ';
    const TOKENS = ['claude', 'const', '=>', 'async', 'await', 'dojo', '{ }', 'git', 'npm', '&&', '</>', 'fn', 'λ'];
    const FS = 15;
    const cols = Math.ceil(W / FS);
    const drops = Array.from({ length: cols }, () => ({ y: Math.random() * H * 0.7 - H * 0.35, v: 0.8 + Math.random() * 1.1, tok: Math.random() < 0.06 ? TOKENS[(Math.random() * TOKENS.length) | 0] : null }));
    const sparks = [];
    const logo = new Image();
    logo.src = '../assets/logo.svg';

    // The cut runs from bottom-left to top-right.
    const A = { x: -W * 0.05, y: H * 0.92 }, B = { x: W * 1.05, y: H * 0.06 };
    const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
    const nx = -dy / L, ny = dx / L; // normal of the cut

    const T = { dim: 900, logo: 1200, cut: 1450, cutEnd: 1720, split: 1800, end: 2650 };
    let t0 = performance.now(), snapshot = null, done = false, skipAt = null;

    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);

    const skip = () => { if (!skipAt) skipAt = performance.now(); };
    window.addEventListener('keydown', skip, true);
    cv.addEventListener('mousedown', skip);

    function rain(t) {
      // translucent background = trails; before the logo the rain dims
      const dimK = Math.min(1, Math.max(0, (t - T.dim) / 600));
      ctx.fillStyle = `rgba(5,10,24,${0.14 + dimK * 0.2})`;
      ctx.fillRect(0, 0, W, H);
      ctx.font = `${FS}px Menlo, monospace`;
      ctx.textBaseline = 'top';
      const fade = 1 - dimK * 0.6;
      for (let i = 0; i < cols; i++) {
        const d = drops[i];
        d.y += d.v * FS * 0.55;
        if (d.y > H + 40) { d.y = Math.random() * -120; d.tok = Math.random() < 0.06 ? TOKENS[(Math.random() * TOKENS.length) | 0] : null; }
        const x = i * FS;
        const ch = d.tok || GLYPHS[(Math.random() * GLYPHS.length) | 0];
        ctx.fillStyle = `rgba(200,245,255,${0.95 * fade})`; // bright head
        ctx.fillText(ch, x, d.y);
        ctx.fillStyle = `rgba(79,170,255,${0.55 * fade})`;
        ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], x, d.y - FS);
      }
    }

    function mark(t) {
      const k = Math.min(1, Math.max(0, (t - T.logo) / 350));
      if (!k) return;
      const s = 0.92 + 0.08 * k, cx = W / 2, cy = H / 2 - 16;
      ctx.save();
      ctx.globalAlpha = k;
      ctx.shadowColor = 'rgba(79,190,255,.9)';
      ctx.shadowBlur = 40;
      const L0 = 118 * s;
      if (logo.complete && logo.naturalWidth) ctx.drawImage(logo, cx - L0 / 2, cy - L0 / 2 - 22, L0, L0);
      ctx.font = `700 ${30 * s}px "Segoe UI", system-ui, sans-serif`;
      ctx.letterSpacing = '12px';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#e6f6ff';
      ctx.fillText('DOJO', cx + 6, cy + L0 / 2 + 20);
      ctx.restore();
    }

    function blade(t) {
      if (t < T.cut) return;
      const k = Math.min(1, (t - T.cut) / (T.cutEnd - T.cut));
      const e = 1 - (1 - k) ** 3; // fast in, soft out
      const hx = A.x + dx * e, hy = A.y + dy * e;
      const tail = Math.max(0, e - 0.35);
      const tx = A.x + dx * tail, ty = A.y + dy * tail;
      ctx.save();
      ctx.lineCap = 'round';
      // glow, then the white core of the edge
      for (const [w, c, b] of [[16, 'rgba(47,125,255,.35)', 40], [6, 'rgba(120,220,255,.85)', 24], [2, '#ffffff', 8]]) {
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy);
        ctx.strokeStyle = c; ctx.lineWidth = w; ctx.shadowColor = '#4fd2ff'; ctx.shadowBlur = b; ctx.stroke();
      }
      ctx.restore();
      if (k < 1) for (let i = 0; i < 6; i++) sparks.push({ x: hx, y: hy, vx: (Math.random() - 0.3) * 14, vy: (Math.random() - 0.5) * 14, life: 1 });
      if (k >= 1 && t < T.cutEnd + 90) { // flash right after the cut
        ctx.fillStyle = `rgba(170,230,255,${0.35 * (1 - (t - T.cutEnd) / 90)})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    function sparkle() {
      for (let i = sparks.length - 1; i >= 0; i--) {
        const p = sparks[i];
        p.x += p.vx; p.y += p.vy; p.vy += 0.4; p.life -= 0.05;
        if (p.life <= 0) { sparks.splice(i, 1); continue; }
        ctx.fillStyle = `rgba(200,245,255,${p.life})`;
        ctx.fillRect(p.x, p.y, 2.2, 2.2);
      }
    }

    // The two halves of the frozen picture slide apart along the cut's normal.
    function split(t) {
      if (!snapshot) {
        snapshot = document.createElement('canvas');
        snapshot.width = cv.width; snapshot.height = cv.height;
        snapshot.getContext('2d').drawImage(cv, 0, 0);
      }
      const k = Math.min(1, (t - T.split) / (T.end - T.split));
      const e = k * k * (3 - 2 * k);
      const d = e * Math.max(W, H) * 0.55;
      ctx.clearRect(0, 0, W, H);
      const far = 4 * Math.max(W, H);
      const half = (sign) => {
        ctx.save();
        ctx.translate(nx * d * sign, ny * d * sign); // move first, so the clip moves with its half
        ctx.beginPath();
        ctx.moveTo(A.x - dx * 2, A.y - dy * 2);
        ctx.lineTo(B.x + dx * 2, B.y + dy * 2);
        ctx.lineTo(B.x + dx * 2 + nx * far * sign, B.y + dy * 2 + ny * far * sign);
        ctx.lineTo(A.x - dx * 2 + nx * far * sign, A.y - dy * 2 + ny * far * sign);
        ctx.closePath();
        ctx.clip();
        ctx.globalAlpha = 1 - e * 0.9;
        ctx.drawImage(snapshot, 0, 0, W, H);
        ctx.restore();
      };
      half(1); half(-1);
      // the glowing seam stays a moment
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - k * 2.2);
      ctx.strokeStyle = '#bff4ff'; ctx.lineWidth = 2; ctx.shadowColor = '#4fd2ff'; ctx.shadowBlur = 24;
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
      ctx.restore();
      sparkle();
      return k >= 1;
    }

    function finish() {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', skip, true);
      cv.style.transition = 'opacity .18s';
      cv.style.opacity = '0';
      setTimeout(() => cv.remove(), 200);
    }

    function frame(now) {
      if (done) return;
      let t = now - t0;
      if (skipAt) { if (t < T.split) { t0 -= T.split - t; t = T.split; } else if (now - skipAt > 260) return finish(); }
      if (t < T.split) {
        rain(t); mark(t); blade(t); sparkle();
      } else if (split(t)) return finish();
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
})();
