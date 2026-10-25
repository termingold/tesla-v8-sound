/**
 * Pulse-driven V8 (original) — BufferSource impulse loop + oscillators.
 * No ScriptProcessor (silent/broken on some Tesla/Chromium builds).
 * No continuous jet noise.
 */
(function (global) {
  'use strict';

  const ENGINES = {
    'v8-cross': {
      id: 'v8-cross',
      nameDe: 'V8 Cross-Plane',
      cylinders: 8,
      idleRpm: 700,
      redline: 6500,
      gears: 6,
      cylWeights: [1.0, 0.42, 0.95, 0.38, 1.05, 0.4, 0.9, 0.45],
      fireFrac: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875],
      toneBright: 0.4,
      rumble: 1.0,
      crackle: 0.8,
    },
    'v8-flat': {
      id: 'v8-flat',
      nameDe: 'V8 Flat-Plane',
      cylinders: 8,
      idleRpm: 1000,
      redline: 8500,
      gears: 7,
      cylWeights: [1, 0.97, 1.02, 0.98, 1.0, 0.99, 1.01, 0.98],
      fireFrac: [0, 0.25, 0.5, 0.75, 0.125, 0.375, 0.625, 0.875],
      toneBright: 0.75,
      rumble: 0.35,
      crackle: 0.65,
    },
    'i6-na': {
      id: 'i6-na',
      nameDe: 'Reihensechser',
      cylinders: 6,
      idleRpm: 750,
      redline: 7200,
      gears: 6,
      cylWeights: [1, 0.95, 1.02, 0.96, 1.0, 0.97],
      fireFrac: [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6],
      toneBright: 0.55,
      rumble: 0.5,
      crackle: 0.4,
    },
  };

  const GEAR_RATIOS = [0, 3.6, 2.25, 1.55, 1.18, 0.92, 0.74, 0.62];
  const FINAL_DRIVE = 3.73;
  const WHEEL_RADIUS = 0.35;

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  /** One 4-stroke cycle of uneven combustion pulses (procedural, no samples). */
  function makePulseCycleBuffer(ctx, engine) {
    const idle = engine.idleRpm;
    // Duration of two crank revolutions at idle (= full firing order once)
    const dur = 120 / idle; // seconds
    const sr = ctx.sampleRate;
    const n = Math.max(2048, Math.floor(sr * dur));
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const cyl = engine.cylinders;
    const decaySamples = Math.floor(sr * 0.012); // ~12 ms pulse tail

    for (let c = 0; c < cyl; c++) {
      const start = Math.floor((engine.fireFrac[c] % 1) * n);
      const amp = (engine.cylWeights[c] || 1) * 0.9;
      for (let i = 0; i < decaySamples; i++) {
        const idx = (start + i) % n;
        const t = i / sr;
        const env = Math.exp(-t * 180) - Math.exp(-t * 900); // thumpy click
        // Low-ish tonal click (not broadband hiss)
        const tone =
          Math.sin(2 * Math.PI * 90 * t) * 0.7 +
          Math.sin(2 * Math.PI * 180 * t) * 0.35 +
          Math.sin(2 * Math.PI * 270 * t) * 0.15 * engine.toneBright;
        d[idx] += amp * env * tone;
      }
    }
    // Normalize
    let peak = 0.001;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
    const norm = 0.95 / peak;
    for (let i = 0; i < n; i++) d[i] *= norm;
    return buf;
  }

  function makeCrackleBuffer(ctx) {
    const n = Math.floor(ctx.sampleRate * 0.04);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const env = Math.exp(-i / (ctx.sampleRate * 0.012));
      d[i] = (Math.random() * 2 - 1) * env * 0.8;
    }
    return buf;
  }

  class EngineSynth {
    constructor() {
      this.ctx = null;
      this.running = false;
      this.engineId = 'v8-cross';
      this.rpm = 700;
      this.targetRpm = 700;
      this.load = 0.14;
      this.volume = 0.7;
      this.gear = 1;
      this.manualShift = false;
      this.shiftHoldUntil = 0;
      this.demoActive = false;
      this._demoTimer = null;
      this._demoSpeed = 0;
      this._tick = null;
      this._lastT = 0;
      this._prevLoad = 0.2;
      this._shifting = false;
      this.lastError = null;
      this.audioState = 'idle';
    }

    get engine() {
      return ENGINES[this.engineId] || ENGINES['v8-cross'];
    }
    get maxGear() {
      return this.engine.gears || 6;
    }
    listEngines() {
      return Object.values(ENGINES);
    }

    async ensureContext() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) throw new Error('Web Audio API fehlt in diesem Browser');
        this.ctx = new AC();
      }
      // Critical: unlock on user gesture
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      this.audioState = this.ctx.state;
      return this.ctx;
    }

    async start() {
      this.lastError = null;
      try {
        await this.ensureContext();
        // Second resume after graph build (some mobile browsers need it)
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        if (this.running) {
          this.audioState = this.ctx.state;
          return;
        }
        this._buildGraph();
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        this.running = true;
        this.rpm = this.engine.idleRpm;
        this.targetRpm = this.rpm;
        this.load = 0.18; // audible idle load
        this.gear = 1;
        this._lastT = this.ctx.currentTime;
        this._applyVoice(true);
        // Audible proof-of-life click then idle
        this._startClick();
        this.audioState = this.ctx.state;
        this._tick = requestAnimationFrame(() => this._loop());
      } catch (err) {
        this.lastError = String(err && err.message ? err.message : err);
        this.audioState = this.ctx ? this.ctx.state : 'error';
        throw err;
      }
    }

    stop() {
      this.stopDemo();
      this.running = false;
      if (this._tick) cancelAnimationFrame(this._tick);
      this._tick = null;
      this._teardown();
      this.audioState = this.ctx ? this.ctx.state : 'stopped';
    }

    setEngine(id) {
      if (!ENGINES[id]) return;
      const was = this.running;
      const demo = this.demoActive;
      if (was) this.stop();
      this.engineId = id;
      this.rpm = ENGINES[id].idleRpm;
      this.targetRpm = this.rpm;
      this.gear = 1;
      if (was) {
        this.start().then(() => {
          if (demo) this.playDemoDrive();
        });
      }
    }

    setVolume(v) {
      this.volume = clamp(v, 0, 1);
      if (this._master && this.ctx) {
        this._master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.03);
      }
    }

    updateFromTelemetry(speedKmh, accelHint) {
      if (this.demoActive) return;
      const e = this.engine;
      const speed = Math.max(0, speedKmh || 0);
      const now = performance.now();
      let load;
      if (typeof accelHint === 'number' && !Number.isNaN(accelHint)) {
        load = clamp(0.12 + accelHint * 0.95, 0.05, 1);
      } else {
        load = speed < 2 ? 0.18 : clamp(0.28 + speed / 220, 0.22, 0.75);
      }
      if (!this.manualShift || now > this.shiftHoldUntil) {
        this.manualShift = false;
        this._autoGear(speed, load, e);
      }
      const wheelRpm =
        speed > 0.5 ? ((speed / 3.6) / (2 * Math.PI * WHEEL_RADIUS)) * 60 : 0;
      const ratio = GEAR_RATIOS[this.gear] || 1.5;
      let rpm = wheelRpm * ratio * FINAL_DRIVE;
      if (speed < 1.2) rpm = e.idleRpm * (1 + load * 0.12);
      else if (load < 0.2) rpm *= 0.9;
      else rpm *= 1 + load * 0.05;
      if (load > 0.85 && rpm > e.redline * 0.98 && this.gear < this.maxGear) {
        this._doUpshift(true);
        rpm = this.rpm * 0.75;
      }
      this.load = load;
      this.targetRpm = clamp(rpm, e.idleRpm * 0.9, e.redline * 1.02);
    }

    setRev(amount) {
      if (this.demoActive) return;
      const e = this.engine;
      this.load = clamp(amount, 0, 1);
      this.targetRpm = e.idleRpm + (e.redline - e.idleRpm) * Math.pow(this.load, 0.82);
    }

    shiftUp() {
      this._doUpshift(false);
    }
    shiftDown() {
      this._doDownshift();
    }

    _autoGear(speed, load, e) {
      const shiftRpm = load > 0.7 ? e.redline * 0.9 : e.redline * (0.52 + load * 0.3);
      const downRpm = e.idleRpm * 1.35;
      const wheelRpm =
        speed > 0.5 ? ((speed / 3.6) / (2 * Math.PI * WHEEL_RADIUS)) * 60 : 0;
      const rpmNow = wheelRpm * (GEAR_RATIOS[this.gear] || 1.5) * FINAL_DRIVE;
      if (rpmNow > shiftRpm && this.gear < this.maxGear && load > 0.15) this._doUpshift(true);
      else if (rpmNow < downRpm && this.gear > 1 && speed > 3) this._doDownshift(true);
      else {
        let g = 1;
        const bands = [0, 18, 38, 58, 85, 115, 150, 200];
        for (let i = 1; i <= this.maxGear; i++) if (speed >= bands[i - 1]) g = i;
        if (!this._shifting && Math.abs(g - this.gear) >= 2) {
          if (g > this.gear) this._doUpshift(true);
          else this._doDownshift(true);
        }
      }
    }

    _doUpshift(auto) {
      if (this.gear >= this.maxGear || this._shifting) return;
      this._shifting = true;
      this.gear++;
      if (!auto) {
        this.manualShift = true;
        this.shiftHoldUntil = performance.now() + 2200;
      }
      this.targetRpm = Math.max(this.engine.idleRpm, this.rpm * 0.66);
      this.rpm *= 0.7;
      setTimeout(() => {
        this._shifting = false;
      }, 160);
    }

    _doDownshift(auto) {
      if (this.gear <= 1 || this._shifting) return;
      this._shifting = true;
      this.gear--;
      if (!auto) {
        this.manualShift = true;
        this.shiftHoldUntil = performance.now() + 2200;
      }
      this.targetRpm = Math.min(this.engine.redline * 0.94, this.rpm * 1.38);
      this.rpm = Math.min(this.engine.redline * 0.95, this.rpm * 1.32);
      this._fireCrackle(3);
      setTimeout(() => {
        this._shifting = false;
      }, 200);
    }

    playDemoDrive() {
      this.stopDemo();
      if (!this.running) return;
      this.demoActive = true;
      const e = this.engine;
      const steps = [
        { t: 0, rpm: e.idleRpm, load: 0.2, gear: 1, speed: 0 },
        { t: 5.0, rpm: e.idleRpm * 1.02, load: 0.22, gear: 1, speed: 0 },
        { t: 5.5, rpm: e.redline * 0.4, load: 0.9, gear: 1, speed: 0 },
        { t: 6.0, rpm: e.idleRpm, load: 0.15, gear: 1, speed: 0, crackle: true },
        { t: 6.8, rpm: e.redline * 0.55, load: 1.0, gear: 1, speed: 30 },
        { t: 8.0, rpm: e.redline * 0.92, load: 1.0, gear: 1, speed: 55 },
        { t: 8.2, rpm: e.redline * 0.6, load: 0.95, gear: 2, speed: 60 },
        { t: 9.5, rpm: e.redline * 0.9, load: 1.0, gear: 2, speed: 95 },
        { t: 9.7, rpm: e.redline * 0.58, load: 0.95, gear: 3, speed: 100 },
        { t: 11.0, rpm: e.redline * 0.85, load: 0.9, gear: 3, speed: 130 },
        { t: 11.5, rpm: e.redline * 0.5, load: 0.05, gear: 3, speed: 125, crackle: true },
        { t: 13.0, rpm: e.idleRpm * 2, load: 0.12, gear: 2, speed: 40 },
        { t: 14.0, rpm: e.redline * 0.88, load: 1.0, gear: 2, speed: 70 },
        { t: 16.0, rpm: e.redline * 0.65, load: 0.6, gear: 3, speed: 110 },
        { t: 17.5, rpm: e.idleRpm, load: 0.18, gear: 1, speed: 0, crackle: true },
        { t: 20.0, rpm: e.idleRpm, load: 0.18, gear: 1, speed: 0, end: true },
      ];
      const t0 = performance.now();
      let i = 0;
      const tick = () => {
        if (!this.demoActive || !this.running) return;
        const elapsed = (performance.now() - t0) / 1000;
        while (i < steps.length - 1 && elapsed >= steps[i + 1].t) i++;
        const a = steps[i];
        const b = steps[Math.min(i + 1, steps.length - 1)];
        const u = clamp((elapsed - a.t) / Math.max(0.001, b.t - a.t), 0, 1);
        this.gear = a.gear;
        this.load = a.load + (b.load - a.load) * u;
        this.targetRpm = a.rpm + (b.rpm - a.rpm) * u;
        this._demoSpeed = a.speed + (b.speed - a.speed) * u;
        if (a.crackle && !a._cr) {
          a._cr = true;
          this._fireCrackle(5);
        }
        if (a.end || elapsed > 21) {
          this.demoActive = false;
          this.load = 0.18;
          this.targetRpm = e.idleRpm;
          this.gear = 1;
          this._demoSpeed = 0;
          return;
        }
        this._demoTimer = requestAnimationFrame(tick);
      };
      this._demoTimer = requestAnimationFrame(tick);
    }

    stopDemo() {
      this.demoActive = false;
      if (this._demoTimer) cancelAnimationFrame(this._demoTimer);
      this._demoTimer = null;
    }
    get demoSpeed() {
      return this._demoSpeed || 0;
    }

    _startClick() {
      if (!this.ctx || !this._master) return;
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.frequency.value = 120;
      o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(g);
      g.connect(this._master);
      o.start(t);
      o.stop(t + 0.1);
    }

    _fireCrackle(count) {
      if (!this.ctx || !this._crackleBuf || !this._master) return;
      const t0 = this.ctx.currentTime;
      for (let i = 0; i < count; i++) {
        const src = this.ctx.createBufferSource();
        src.buffer = this._crackleBuf;
        const g = this.ctx.createGain();
        g.gain.value = 0.15 + Math.random() * 0.25 * this.engine.crackle;
        src.connect(g);
        g.connect(this._master);
        src.start(t0 + i * (0.04 + Math.random() * 0.05));
      }
    }

    _buildGraph() {
      const ctx = this.ctx;
      const e = this.engine;
      this._teardown();

      this._master = ctx.createGain();
      this._master.gain.value = this.volume;

      this._pulseGain = ctx.createGain();
      this._pulseGain.gain.value = 0.7;

      this._bodyGain = ctx.createGain();
      this._bodyGain.gain.value = 0.2;

      this._lp = ctx.createBiquadFilter();
      this._lp.type = 'lowpass';
      this._lp.frequency.value = 2200;
      this._lp.Q.value = 0.7;

      this._hp = ctx.createBiquadFilter();
      this._hp.type = 'highpass';
      this._hp.frequency.value = 45;

      this._thump = ctx.createBiquadFilter();
      this._thump.type = 'peaking';
      this._thump.frequency.value = 95;
      this._thump.Q.value = 0.9;
      this._thump.gain.value = 7;

      this._bark = ctx.createBiquadFilter();
      this._bark.type = 'peaking';
      this._bark.frequency.value = 450;
      this._bark.Q.value = 1.1;
      this._bark.gain.value = 3;

      // Pulse loop — the main voice
      this._pulseBuf = makePulseCycleBuffer(ctx, e);
      this._pulse = ctx.createBufferSource();
      this._pulse.buffer = this._pulseBuf;
      this._pulse.loop = true;
      this._pulse.playbackRate.value = 1;
      this._pulse.connect(this._pulseGain);
      this._pulseGain.connect(this._thump);

      // Body oscillators (quiet, follow RPM) — pulsed via gain, not noise
      this._body = ctx.createOscillator();
      this._body.type = 'sawtooth';
      this._body.frequency.value = 70;
      this._body.connect(this._bodyGain);

      this._sub = ctx.createOscillator();
      this._sub.type = 'sine';
      this._subGain = ctx.createGain();
      this._subGain.gain.value = 0.15;
      this._sub.connect(this._subGain);

      this._thump.connect(this._bark);
      this._bark.connect(this._lp);
      this._bodyGain.connect(this._lp);
      this._subGain.connect(this._lp);
      this._lp.connect(this._hp);
      this._hp.connect(this._master);
      this._master.connect(ctx.destination);

      this._crackleBuf = makeCrackleBuffer(ctx);

      this._pulse.start();
      this._body.start();
      this._sub.start();
      this._prevLoad = 0.2;
    }

    _teardown() {
      const stop = (n) => {
        if (!n) return;
        try {
          n.stop();
        } catch (_) {}
        try {
          n.disconnect();
        } catch (_) {}
      };
      try {
        stop(this._pulse);
        stop(this._body);
        stop(this._sub);
        if (this._master) this._master.disconnect();
      } catch (_) {}
      this._pulse = null;
      this._body = null;
      this._sub = null;
    }

    _applyVoice(immediate) {
      if (!this.ctx || !this._pulse) return;
      const e = this.engine;
      const t = this.ctx.currentTime;
      const tc = immediate ? 0.01 : 0.05;
      const rpmN = clamp((this.rpm - e.idleRpm) / (e.redline - e.idleRpm), 0, 1.05);

      // playbackRate 1.0 = idle cycle; scales linearly with RPM
      const rate = clamp(this.rpm / e.idleRpm, 0.5, e.redline / e.idleRpm);
      this._pulse.playbackRate.setTargetAtTime(rate, t, tc);

      // Pulse loudness: always audible at idle; louder under load; quieter (not silent) on coast
      const pulseAmp =
        (0.45 + this.load * 0.5) * (0.85 + e.rumble * 0.2) * (this.load < 0.15 ? 0.75 : 1);
      this._pulseGain.gain.setTargetAtTime(pulseAmp, t, tc);

      // Body follows firing-ish frequency
      const fireHz = (this.rpm / 60) * (e.cylinders / 2);
      const bodyF = Math.max(55, fireHz * 0.5);
      this._body.frequency.setTargetAtTime(bodyF, t, tc);
      this._bodyGain.gain.setTargetAtTime(
        (0.04 + this.load * 0.14) * (0.5 + rpmN * 0.6) * e.toneBright,
        t,
        tc
      );

      this._sub.frequency.setTargetAtTime(Math.max(35, this.rpm / 60), t, tc);
      this._subGain.gain.setTargetAtTime(
        (0.08 + this.load * 0.1) * e.rumble * (1 - rpmN * 0.4),
        t,
        tc
      );

      const cut = 1000 + rpmN * 2800 + this.load * 1200 - (this.load < 0.2 ? 400 : 0);
      this._lp.frequency.setTargetAtTime(clamp(cut, 600, 6500), t, tc);
      this._bark.gain.setTargetAtTime(2 + this.load * 6, t, tc);
      this._thump.gain.setTargetAtTime(5 + e.rumble * 3 * (1 - rpmN * 0.5), t, tc);
    }

    _loop() {
      if (!this.running || !this.ctx) return;
      const t = this.ctx.currentTime;
      const dt = Math.min(0.05, Math.max(0.008, t - (this._lastT || t - 0.016)));
      this._lastT = t;

      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      this.audioState = this.ctx.state;

      const lag = this.load > 0.5 ? 0.05 : 0.11;
      this.rpm += (this.targetRpm - this.rpm) * Math.min(1, dt / lag);
      this.rpm = clamp(this.rpm, this.engine.idleRpm * 0.85, this.engine.redline * 1.05);

      const dLoad = this._prevLoad - this.load;
      if (dLoad > 0.28 && this.rpm > this.engine.idleRpm * 1.5) {
        this._fireCrackle(2 + Math.floor(dLoad * 6));
      }
      this._prevLoad = this.load;
      this._applyVoice(false);

      this._tick = requestAnimationFrame(() => this._loop());
    }
  }

  global.EngineSynth = EngineSynth;
  global.ENGINE_PRESETS = ENGINES;
})(window);
