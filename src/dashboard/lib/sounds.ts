// Tiny notification sounds made with the Web Audio API, so there are no audio files to host.

let ctx: AudioContext | null = null;

function tone(freq: number, start: number, duration: number, volume = 0.15, type: OscillatorType = 'sine') {
  if (!ctx) ctx = new AudioContext();
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + duration + 0.05);
}

/** Soft "someone arrived" ping. */
export function playVisitor() {
  try {
    tone(880, 0, 0.25, 0.08);
  } catch {}
}

/** Cash-register style chime for a payment. */
export function playPayment() {
  try {
    tone(1318.5, 0, 0.18, 0.12, 'triangle');
    tone(1760, 0.09, 0.35, 0.12, 'triangle');
    tone(2637, 0.18, 0.45, 0.08, 'sine');
  } catch {}
}

/** Browsers only allow audio after a user gesture; call this from the sound toggle's click. */
export function unlockAudio() {
  try {
    if (!ctx) ctx = new AudioContext();
    void ctx.resume();
  } catch {}
}

/** A cash register for "Live payments": the drawer ("cha", a burst of filtered noise), then the bell ("ching"). */
export function playCashRegister() {
  try {
    if (!ctx) ctx = new AudioContext();
    const seconds = 0.12;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
    const drawer = ctx.createBufferSource();
    drawer.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2800;
    const gain = ctx.createGain();
    gain.gain.value = 0.3;
    drawer.connect(filter).connect(gain).connect(ctx.destination);
    drawer.start();
    tone(2093, 0.09, 1.0, 0.13, 'triangle');
    tone(3136, 0.09, 0.8, 0.06, 'sine');
    tone(4186, 0.11, 0.55, 0.04, 'sine');
  } catch {}
}
