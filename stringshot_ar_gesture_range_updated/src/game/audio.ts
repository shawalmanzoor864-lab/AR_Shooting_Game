class TacticalAudioEngine {
  private ctx: AudioContext | null = null;
  private muted = false;

  private ensureContext(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public unlock() {
    this.ensureContext();
  }

  public setMuted(muted: boolean) {
    this.muted = muted;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public playGunshot() {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;

    // 1. Sub-bass punch
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(165, now);
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.11);
    oscGain.gain.setValueAtTime(0.55, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
    osc.connect(oscGain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.14);

    // 2. High-pressure crack noise burst
    const bufferSize = Math.floor(ctx.sampleRate * 0.18);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      const env = Math.pow(1 - i / bufferSize, 2.2);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1600, now);
    filter.Q.setValueAtTime(0.7, now);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.65, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.17);

    noise.connect(filter).connect(noiseGain).connect(ctx.destination);
    noise.start(now);

    // 3. Metallic slide clack
    const clack = ctx.createOscillator();
    const clackGain = ctx.createGain();
    clack.type = 'square';
    clack.frequency.setValueAtTime(2200, now + 0.03);
    clack.frequency.exponentialRampToValueAtTime(900, now + 0.07);
    clackGain.gain.setValueAtTime(0.08, now + 0.03);
    clackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.075);
    clack.connect(clackGain).connect(ctx.destination);
    clack.start(now + 0.03);
    clack.stop(now + 0.08);
  }

  public playDryFire() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1400, now);
    osc.frequency.exponentialRampToValueAtTime(520, now + 0.035);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.045);
  }

  public playReload() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    // Stage 1: Mag release click (0.05s)
    // Stage 2: Mag insert thud (0.35s)
    // Stage 3: Slide rack zip (0.62s)
    const stages = [
      { t: 0.04, f1: 900, f2: 400, dur: 0.06, vol: 0.14 },
      { t: 0.34, f1: 320, f2: 140, dur: 0.09, vol: 0.24 },
      { t: 0.62, f1: 1850, f2: 1100, dur: 0.08, vol: 0.16 },
      { t: 0.72, f1: 2400, f2: 1350, dur: 0.06, vol: 0.18 },
    ];

    for (const s of stages) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(s.f1, now + s.t);
      osc.frequency.exponentialRampToValueAtTime(s.f2, now + s.t + s.dur);
      gain.gain.setValueAtTime(s.vol, now + s.t);
      gain.gain.exponentialRampToValueAtTime(0.001, now + s.t + s.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + s.t);
      osc.stop(now + s.t + s.dur + 0.01);
    }
  }

  public playTargetHit(zone: 'bullseye' | 'inner' | 'outer') {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    // Wood/board impact thud
    const thud = ctx.createOscillator();
    const thudGain = ctx.createGain();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(210, now);
    thud.frequency.exponentialRampToValueAtTime(65, now + 0.08);
    thudGain.gain.setValueAtTime(0.28, now);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    thud.connect(thudGain).connect(ctx.destination);
    thud.start(now);
    thud.stop(now + 0.095);

    // Precision ping
    const ping = ctx.createOscillator();
    const pingGain = ctx.createGain();
    ping.type = 'sine';
    const baseFreq = zone === 'bullseye' ? 1320 : zone === 'inner' ? 987 : 740;
    ping.frequency.setValueAtTime(baseFreq, now + 0.015);
    if (zone === 'bullseye') {
      ping.frequency.setValueAtTime(1760, now + 0.08);
    }
    pingGain.gain.setValueAtTime(0.22, now + 0.015);
    pingGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    ping.connect(pingGain).connect(ctx.destination);
    ping.start(now + 0.015);
    ping.stop(now + 0.26);
  }

  public playTargetBreak() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.045);
      gain.gain.setValueAtTime(0.14, now + idx * 0.045);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.045 + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + idx * 0.045);
      osc.stop(now + idx * 0.045 + 0.18);
    });
  }

  public playOutOfBoundsAlert() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    for (let i = 0; i < 3; i++) {
      const start = now + i * 0.16;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(440, start);
      osc.frequency.setValueAtTime(310, start + 0.07);
      gain.gain.setValueAtTime(0.16, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.15);
    }
  }

  public playLevelClear() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const chord = [440, 554.37, 659.25, 880];
    chord.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.08);
      gain.gain.setValueAtTime(0.18, now + idx * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + idx * 0.08);
      osc.stop(now + idx * 0.08 + 0.37);
    });
  }
}

export const audioEngine = new TacticalAudioEngine();
