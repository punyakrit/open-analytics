/**
 * Fireworks for a new payment: rockets rise from the bottom and burst, on a canvas laid over the page for a
 * couple of seconds and then removed. Skipped entirely when the system asks for reduced motion.
 */
const COLORS = ['#5b7cfa', '#f2b44e', '#3ed6a5', '#e5677a', '#a07cf0', '#ffd166'];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
}
interface Rocket {
  x: number;
  y: number;
  vy: number;
  top: number;
  color: string;
}

export function launchFireworks(bursts = 4) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '80' });
  canvas.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas.remove();
  ctx.scale(dpr, dpr);

  const particles: Particle[] = [];
  const rockets: Rocket[] = [];
  const launchesUntil = performance.now() + bursts * 380;
  for (let i = 0; i < bursts; i++) {
    setTimeout(() => rockets.push({ x: w * (0.15 + Math.random() * 0.7), y: h, vy: -(h / 55 + Math.random() * 4), top: h * (0.15 + Math.random() * 0.3), color: pick(COLORS) }), i * 380);
  }
  const explode = (x: number, y: number, color: string) => {
    const n = 80;
    for (let i = 0; i < n; i++) {
      const angle = (Math.PI * 2 * i) / n + Math.random() * 0.2;
      const speed = 1.8 + Math.random() * 4.8;
      particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 0, max: 55 + Math.random() * 35, color: Math.random() < 0.2 ? '#ffffff' : color, size: 1.4 + Math.random() * 1.8 });
    }
  };

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(2.5, (now - last) / 16.7);
    last = now;
    ctx.clearRect(0, 0, w, h);
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.y += r.vy * dt;
      r.vy *= 0.99;
      ctx.globalAlpha = 1;
      ctx.fillStyle = r.color;
      ctx.fillRect(r.x - 1.5, r.y, 3, 10);
      if (r.y <= r.top) {
        explode(r.x, r.y, r.color);
        rockets.splice(i, 1);
      }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.vx *= 0.97;
      p.vy = p.vy * 0.97 + 0.07 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life += dt;
      const alpha = 1 - p.life / p.max;
      if (alpha <= 0) {
        particles.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    if (now < launchesUntil || rockets.length || particles.length) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
