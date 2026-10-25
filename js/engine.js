/**
 * Procedural engine synthesizer (original work).
 * Inspired by public descriptions of real-time combustion/exhaust/intake
 * synthesis + virtual gearbox behaviour — no third-party samples or code.
 */
(function (global) {
  'use strict';

  /**
   * Cross-plane V8 bank unevenness: classic 90° V8 fires every 90° of crank,
   * but each bank hears 180-90-180-270 → idle "lope".
   * Flat-plane: even 180° → smoother, higher, more exotic.
   */
  const ENGINES = {
    'v8-cross': {
      id: 'v8-cross',
      nameDe: 'V8 Cross-Plane (US Muscle)',
      cylinders: 8,
      idleRpm: 700,
      redline: 6500,
      gears: 6,
      // Per-cylinder relative amplitude (lope / unevenness)
      cylWeights: [1.0, 0.72, 1.05, 0.68, 0.95, 0.75, 1.08, 0.7],
      // Crank degrees between successive firings (sum ≈ 720 for 4-stroke cycle group)
      fireDeg: [0, 90, 180, 270, 360, 450, 540, 630],
      fundMul: 1.0,
      harmBright: 0.45,
      rumble: 1.0,
      intake: 0.55,
      exhaust: 0.95,
      crackle: 0.7,
      lopeDepth: 0.55,
      tone: 'muscle',
    },
    'v8-flat': {
      id: 'v8-flat',
      nameDe: 'V8 Flat-Plane (Sport)',
      cylinders: 8,
      idleRpm: 1000,
      redline: 9000,
      gears: 7,
      cylWeights: [1, 0.98, 1.02, 0.97, 1.01, 0.99, 1.0, 0.98],
      fireDeg: [0, 180, 360, 540, 90, 270, 450, 630],
      fundMul: 1.15,
      harmBright: 0.85,
      rumble: 0.35,
      intake: 0.8,
      exhaust: 0.7,
      crackle: 0.85,
      lopeDepth: 0.08,
      tone: 'sport',
    },
    'i6-na': {
      id: 'i6-na',
      nameDe: 'Reihensechser',
      cylinders: 6,
      idleRpm: 750,
      redline: 7200,
      gears: 6,
      cylWeights: [1, 0.96, 1.02, 0.97, 1.01, 0.98],
      fireDeg: [0, 120, 240, 360, 480, 600],
      fundMul: 1.05,
      harmBright: 0.65,
      rumble: 0.45,
      intake: 0.65,
      exhaust: 0.75,
      crackle: 0.5,
      lopeDepth: 0.12,
      tone: 'smooth',
    },
  };

  const GEAR_RATIOS = [0, 3.6, 2.25, 1.55, 1.18, 0.92, 0.74, 0.62];
  const FINAL_DRIVE = 3.73;
  const WHEEL_RADIUS = 0.35; // m

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function makeNoiseBuffer(ctx, seconds, type) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    if (type === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  function makeDistortion(amount) {
    const n = 512;
    const curve = new Float32Array(n);
    const k = typeof amount === 'number' ? amount : 30;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  class EngineSynth {
    constructor() {
      this.ctx = null;
      this.running = false;
      this.engineId = 'v8-cross';
      this.rpm = 700;
      this.targetRpm = 700;
      this.load = 0.12;
      this.volume = 0.55;
      this.gear = 1;
      this.manualShift = false;
      this.shiftHoldUntil = 0;
      this.demoActive = false;
      this._demoTimer = null;

      this._tick = null;
      this._lastT = 0;
      this._phase = 0; // combustion cycle phase in firings
      this._prevLoad = 0.2;
      this._crackleNext = 0;
      this._shifting = false;
      this._limiterBounce = 0;

      // audio nodes
      this._harmonics = [];
      this._pulseGain = null;
      this._exGain = null;
      this._inGain = null;
      this._subGain = null;
      this._lopeLfo = null;
      this._master = null;
      this._outGain = null;
      this._lp = null;
      this._hp = null;
      this._shaper = null;
      this._exNoise = null;
      this._inNoise = null;
      this._crackGain = null;
      this._pulseOsc = null;
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
        this.ctx = new AC({ latencyHint: 'interactive' });
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx;
    }

    async start() {
      await this.ensureContext();
      if (this.running) return;
      this._buildGraph();
      this.running = true;
      this.rpm = this.engine.idleRpm;
      this.targetRpm = this.rpm;
      this.load = 0.12;
      this.gear = 1;
      this._lastT = this.ctx.currentTime;
      this._phase = 0;
      this._tick = requestAnimationFrame(() => this._loop());
    }

    stop() {
      this.stopDemo();
      this.running = false;
      if (this._tick) cancelAnimationFrame(this._tick);
      this._tick = null;
      this._teardown();
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
      if (this._outGain && this.ctx) {
        this._outGain.gain.setTargetAtTime(this.volume * 0.9, this.ctx.currentTime, 0.05);
      }
    }

    /**
     * Map vehicle speed + optional accel (−1…1) → RPM / load / auto gearbox.
     */
    updateFromTelemetry(speedKmh, accelHint) {
      if (this.demoActive) return;
      const e = this.engine;
      const speed = Math.max(0, speedKmh || 0);
      const now = performance.now();

      let load;
      if (typeof accelHint === 'number' && !Number.isNaN(accelHint)) {
        load = clamp(0.15 + accelHint * 0.95, 0.02, 1);
      } else {
        // GPS-only: mild assumed load while moving
        load = speed < 2 ? 0.12 : clamp(0.25 + speed / 220, 0.2, 0.7);
      }

      // Auto gearbox (unless manual hold)
      if (!this.manualShift || now > this.shiftHoldUntil) {
        this.manualShift = false;
        this._autoGear(speed, load, e);
      }

      const wheelRpm = speed > 0.5
        ? (speed / 3.6) / (2 * Math.PI * WHEEL_RADIUS) * 60
        : 0;
      const ratio = GEAR_RATIOS[this.gear] || 1.5;
      let rpm = wheelRpm * ratio * FINAL_DRIVE;

      if (speed < 1.2) {
        rpm = e.idleRpm * (1 + load * 0.15);
      } else {
        // Under load, hold closer to shift point; on coast, drop toward idle band of gear
        if (load < 0.2) rpm *= 0.92;
        else rpm *= 1 + load * 0.06;
      }

      // Rev-limiter bounce under full load at top of gear
      if (load > 0.85 && rpm > e.redline * 0.98 && this.gear < this.maxGear) {
        this._limiterBounce = 1;
        // try upshift
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
      this.targetRpm = e.idleRpm + (e.redline - e.idleRpm) * Math.pow(this.load, 0.85);
    }

    shiftUp() {
      this._doUpshift(false);
    }

    shiftDown() {
      this._doDownshift();
    }

    _autoGear(speed, load, e) {
      // Sport-ish: hold longer under load
      const shiftRpm = load > 0.7 ? e.redline * 0.92 : e.redline * (0.55 + load * 0.3);
      const downRpm = e.idleRpm * 1.35;

      const wheelRpm = speed > 0.5
        ? (speed / 3.6) / (2 * Math.PI * WHEEL_RADIUS) * 60
        : 0;
      const rpmNow = wheelRpm * (GEAR_RATIOS[this.gear] || 1.5) * FINAL_DRIVE;

      if (rpmNow > shiftRpm && this.gear < this.maxGear && load > 0.15) {
        this._doUpshift(true);
      } else if (rpmNow < downRpm && this.gear > 1 && speed > 3) {
        this._doDownshift(true);
      } else {
        // Speed bands as fallback when rpm estimate is noisy
        let g = 1;
        const bands = [0, 18, 38, 58, 85, 115, 150, 200];
        for (let i = 1; i <= this.maxGear; i++) {
          if (speed >= bands[i - 1]) g = i;
        }
        // Only nudge gear if far off and not mid-shift
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
      // DCT-like dip
      this.targetRpm = Math.max(this.engine.idleRpm, this.rpm * 0.68);
      this.rpm *= 0.72;
      this._shiftThump(false);
      setTimeout(() => { this._shifting = false; }, 180);
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
      this._shiftThump(true);
      // overrun crackles after blip
      this._scheduleCrackles(3 + Math.floor(Math.random() * 3), 0.05);
      setTimeout(() => { this._shifting = false; }, 220);
    }

    _shiftThump(down) {
      if (!this.ctx || !this._crackGain) return;
      const t = this.ctx.currentTime;
      // momentary load spike = throttle blip sound
      const prev = this.load;
      if (down) {
        this.load = Math.min(1, prev + 0.55);
        setTimeout(() => { if (!this.demoActive) this.load = Math.max(0.05, this.load - 0.4); }, 90);
      }
      this._crackGain.gain.cancelScheduledValues(t);
      this._crackGain.gain.setValueAtTime(0.001, t);
      this._crackGain.gain.linearRampToValueAtTime(down ? 0.55 : 0.28, t + 0.015);
      this._crackGain.gain.exponentialRampToValueAtTime(0.001, t + (down ? 0.14 : 0.08));
    }

    _scheduleCrackles(count, spacing) {
      if (!this.ctx || !this._crackGain) return;
      const t0 = this.ctx.currentTime;
      for (let i = 0; i < count; i++) {
        const t = t0 + i * (spacing + Math.random() * 0.04);
        const amp = 0.18 + Math.random() * 0.35 * this.engine.crackle;
        this._crackGain.gain.setValueAtTime(0.001, t);
        this._crackGain.gain.linearRampToValueAtTime(amp, t + 0.008);
        this._crackGain.gain.exponentialRampToValueAtTime(0.001, t + 0.04 + Math.random() * 0.05);
      }
    }

    /** ~20 s scripted demo: idle → launch → lift-off → brake/downshifts → kickdown → stop */
    playDemoDrive() {
      this.stopDemo();
      if (!this.running) return;
      this.demoActive = true;
      const e = this.engine;
      const steps = [
        { t: 0, rpm: e.idleRpm, load: 0.12, gear: 1, speed: 0 },
        { t: 1.5, rpm: e.idleRpm * 1.05, load: 0.15, gear: 1, speed: 0 },
        { t: 2.2, rpm: e.redline * 0.55, load: 0.95, gear: 1, speed: 20 },
        { t: 3.4, rpm: e.redline * 0.92, load: 1.0, gear: 1, speed: 45 },
        { t: 3.55, rpm: e.redline * 0.62, load: 0.95, gear: 2, speed: 50, up: true },
        { t: 4.8, rpm: e.redline * 0.9, load: 1.0, gear: 2, speed: 80 },
        { t: 4.95, rpm: e.redline * 0.6, load: 0.95, gear: 3, speed: 85, up: true },
        { t: 6.2, rpm: e.redline * 0.88, load: 1.0, gear: 3, speed: 115 },
        { t: 6.35, rpm: e.redline * 0.58, load: 0.9, gear: 4, speed: 120, up: true },
        { t: 7.5, rpm: e.redline * 0.7, load: 0.85, gear: 4, speed: 140 },
        // lift-off
        { t: 8.0, rpm: e.redline * 0.55, load: 0.05, gear: 4, speed: 135, crackle: 5 },
        { t: 9.0, rpm: e.redline * 0.4, load: 0.05, gear: 3, speed: 110, down: true },
        { t: 10.2, rpm: e.redline * 0.45, load: 0.08, gear: 2, speed: 70, down: true },
        { t: 11.5, rpm: e.idleRpm * 2.2, load: 0.1, gear: 2, speed: 40 },
        // kickdown overtake
        { t: 12.2, rpm: e.redline * 0.85, load: 1.0, gear: 2, speed: 55, down: true },
        { t: 13.5, rpm: e.redline * 0.95, load: 1.0, gear: 2, speed: 95 },
        { t: 13.65, rpm: e.redline * 0.65, load: 0.95, gear: 3, speed: 100, up: true },
        { t: 15.0, rpm: e.redline * 0.75, load: 0.7, gear: 3, speed: 120 },
        { t: 16.5, rpm: e.redline * 0.35, load: 0.08, gear: 3, speed: 60, crackle: 4 },
        { t: 18.0, rpm: e.idleRpm * 1.4, load: 0.1, gear: 2, speed: 20 },
        { t: 19.5, rpm: e.idleRpm, load: 0.12, gear: 1, speed: 0 },
        { t: 20.5, rpm: e.idleRpm, load: 0.12, gear: 1, speed: 0, end: true },
      ];

      const t0 = performance.now();
      let i = 0;
      const tick = () => {
        if (!this.demoActive || !this.running) return;
        const elapsed = (performance.now() - t0) / 1000;
        while (i < steps.length - 1 && elapsed >= steps[i + 1].t) i++;
        const a = steps[i];
        const b = steps[Math.min(i + 1, steps.length - 1)];
        const span = Math.max(0.001, b.t - a.t);
        const u = clamp((elapsed - a.t) / span, 0, 1);
        this.gear = a.gear;
        this.load = a.load + (b.load - a.load) * u;
        this.targetRpm = a.rpm + (b.rpm - a.rpm) * u;
        this._demoSpeed = a.speed + (b.speed - a.speed) * u;

        if (a.up && !a._did) {
          a._did = true;
          this._shiftThump(false);
        }
        if (a.down && !a._did) {
          a._did = true;
          this._shiftThump(true);
          this._scheduleCrackles(3, 0.06);
        }
        if (a.crackle && !a._cr) {
          a._cr = true;
          this._scheduleCrackles(a.crackle, 0.07);
        }
        if (a.end || elapsed > 21) {
          this.demoActive = false;
          this.load = 0.12;
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

    _buildGraph() {
      const ctx = this.ctx;
      const e = this.engine;
      this._teardown();

      this._outGain = ctx.createGain();
      this._outGain.gain.value = this.volume * 0.9;

      this._master = ctx.createGain();
      this._master.gain.value = 1;

      // Tone stack
      this._lp = ctx.createBiquadFilter();
      this._lp.type = 'lowpass';
      this._lp.frequency.value = 1200;
      this._lp.Q.value = 0.7;

      this._hp = ctx.createBiquadFilter();
      this._hp.type = 'highpass';
      this._hp.frequency.value = 35;
      this._hp.Q.value = 0.5;

      const mid = ctx.createBiquadFilter();
      mid.type = 'peaking';
      mid.frequency.value = e.tone === 'sport' ? 900 : 280;
      mid.Q.value = 0.9;
      mid.gain.value = e.tone === 'sport' ? 4 : 6;

      const presence = ctx.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = e.tone === 'sport' ? 2800 : 1600;
      presence.Q.value = 1.1;
      presence.gain.value = e.harmBright * 5;

      this._shaper = ctx.createWaveShaper();
      this._shaper.curve = makeDistortion(12 + e.rumble * 28);
      this._shaper.oversample = '2x';

      // --- Harmonic bank (firing-rate fundamentals) ---
      // harm 1 = firing frequency fundamental body
      this._harmonics = [];
      const harmCount = 7;
      for (let h = 1; h <= harmCount; h++) {
        const osc = ctx.createOscillator();
        // mix of saw/triangle character via waveshaper later; use saw for grit
        osc.type = h <= 2 ? 'sawtooth' : h === 3 ? 'square' : 'sawtooth';
        const g = ctx.createGain();
        g.gain.value = 0;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 80 * h;
        bp.Q.value = 0.8 + h * 0.15;
        osc.connect(bp);
        bp.connect(g);
        g.connect(this._lp);
        osc.start();
        this._harmonics.push({ osc, g, bp, h });
      }

      // Pulse carrier: amplitude-modulated by combustion envelope (via gain automation in loop)
      this._pulseGain = ctx.createGain();
      this._pulseGain.gain.value = 0.2;

      // Extra detuned body osc for thickness
      this._body = ctx.createOscillator();
      this._body.type = 'sawtooth';
      this._bodyGain = ctx.createGain();
      this._bodyGain.gain.value = 0;
      this._body.connect(this._bodyGain);
      this._bodyGain.connect(this._lp);
      this._body.start();

      this._body2 = ctx.createOscillator();
      this._body2.type = 'triangle';
      this._body2Gain = ctx.createGain();
      this._body2Gain.gain.value = 0;
      this._body2.connect(this._body2Gain);
      this._body2Gain.connect(this._lp);
      this._body2.start();

      // Sub + lope LFO (cross-plane idle chug)
      this._sub = ctx.createOscillator();
      this._sub.type = 'sine';
      this._subGain = ctx.createGain();
      this._subGain.gain.value = 0;
      this._sub.connect(this._subGain);
      this._subGain.connect(this._master);

      this._lope = ctx.createOscillator();
      this._lope.type = 'sine';
      this._lopeGain = ctx.createGain();
      this._lopeGain.gain.value = 0;
      this._lopeDepth = ctx.createGain();
      this._lopeDepth.gain.value = e.lopeDepth * 0.15;
      // lope modulates master slightly via connection to pulse path
      this._lope.connect(this._lopeDepth);
      // We'll apply lope in the loop via gain — keep LFO for sidechain feel
      this._lope.connect(this._lopeGain);
      this._lopeGain.connect(this._master);
      this._sub.start();
      this._lope.start();

      // Exhaust: pink noise through resonant low/band
      const pink = makeNoiseBuffer(ctx, 3, 'pink');
      const white = makeNoiseBuffer(ctx, 2, 'white');

      this._exNoise = ctx.createBufferSource();
      this._exNoise.buffer = pink;
      this._exNoise.loop = true;
      this._exFilter = ctx.createBiquadFilter();
      this._exFilter.type = 'bandpass';
      this._exFilter.frequency.value = 450;
      this._exFilter.Q.value = 0.55;
      this._exFilter2 = ctx.createBiquadFilter();
      this._exFilter2.type = 'lowpass';
      this._exFilter2.frequency.value = 2200;
      this._exGain = ctx.createGain();
      this._exGain.gain.value = 0;
      this._exNoise.connect(this._exFilter);
      this._exFilter.connect(this._exFilter2);
      this._exFilter2.connect(this._exGain);
      this._exGain.connect(this._lp);
      this._exNoise.start();

      // Intake: brighter hiss under throttle
      this._inNoise = ctx.createBufferSource();
      this._inNoise.buffer = white;
      this._inNoise.loop = true;
      this._inFilter = ctx.createBiquadFilter();
      this._inFilter.type = 'bandpass';
      this._inFilter.frequency.value = 1800;
      this._inFilter.Q.value = 0.7;
      this._inGain = ctx.createGain();
      this._inGain.gain.value = 0;
      this._inNoise.connect(this._inFilter);
      this._inFilter.connect(this._inGain);
      this._inGain.connect(this._hp);
      this._inNoise.start();

      // Crackle / pop: gated noise bursts
      this._crackNoise = ctx.createBufferSource();
      this._crackNoise.buffer = white;
      this._crackNoise.loop = true;
      this._crackFilt = ctx.createBiquadFilter();
      this._crackFilt.type = 'bandpass';
      this._crackFilt.frequency.value = 1200;
      this._crackFilt.Q.value = 1.4;
      this._crackGain = ctx.createGain();
      this._crackGain.gain.value = 0;
      this._crackNoise.connect(this._crackFilt);
      this._crackFilt.connect(this._crackGain);
      this._crackGain.connect(this._master);
      this._crackNoise.start();

      // Wire tone stack
      this._lp.connect(this._shaper);
      this._shaper.connect(mid);
      mid.connect(presence);
      presence.connect(this._hp);
      this._hp.connect(this._master);
      this._master.connect(this._outGain);
      this._outGain.connect(ctx.destination);

      this._prevLoad = 0.2;
      this._crackleNext = 0;
      this._combustPhase = 0;
    }

    _teardown() {
      const stop = (n) => {
        if (!n) return;
        try { n.stop(); } catch (_) {}
        try { n.disconnect(); } catch (_) {}
      };
      try {
        (this._harmonics || []).forEach((h) => stop(h.osc));
        stop(this._body);
        stop(this._body2);
        stop(this._sub);
        stop(this._lope);
        stop(this._exNoise);
        stop(this._inNoise);
        stop(this._crackNoise);
        if (this._outGain) try { this._outGain.disconnect(); } catch (_) {}
      } catch (_) {}
      this._harmonics = [];
    }

    _loop() {
      if (!this.running || !this.ctx) return;
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const dt = Math.min(0.05, Math.max(0.008, t - (this._lastT || t - 0.016)));
      this._lastT = t;
      const e = this.engine;

      // RPM inertia — snappier under load, lazier on coast
      const lag = this.load > 0.5 ? 0.055 : 0.14;
      this.rpm += (this.targetRpm - this.rpm) * Math.min(1, dt / lag);
      this.rpm = clamp(this.rpm, e.idleRpm * 0.82, e.redline * 1.06);

      // Lift-off / overrun crackle
      const dLoad = this._prevLoad - this.load;
      if (dLoad > 0.28 && this.rpm > e.idleRpm * 1.6) {
        const n = 2 + Math.floor(dLoad * 8 * e.crackle);
        this._scheduleCrackles(n, 0.05);
      }
      // Continuous light crackle while coasting at high rpm
      if (this.load < 0.18 && this.rpm > e.idleRpm * 2.2 && t > this._crackleNext) {
        this._crackleNext = t + 0.08 + Math.random() * 0.22;
        if (Math.random() < 0.45 * e.crackle) {
          this._scheduleCrackles(1, 0.02);
        }
      }
      this._prevLoad = this.load;

      const rpmN = clamp((this.rpm - e.idleRpm) / (e.redline - e.idleRpm), 0, 1.05);
      // Firing frequency (4-stroke): firings per second = rpm/60 * cylinders/2
      const fireHz = (this.rpm / 60) * (e.cylinders / 2);
      const crankHz = this.rpm / 60;

      // Combustion pulse envelope: sharp peaks at fire rate, uneven for cross-plane
      this._combustPhase += fireHz * dt;
      const cyl = e.cylinders;
      let pulseEnv = 0;
      for (let i = 0; i < cyl; i++) {
        const off = (e.fireDeg[i] || i * (720 / cyl)) / 720;
        // sharp pulse via raised cosine power
        const ph = (this._combustPhase + off) % 1;
        const w = e.cylWeights[i] || 1;
        const spike = Math.pow(Math.max(0, Math.cos(ph * Math.PI * 2)), 8);
        pulseEnv += spike * w;
      }
      pulseEnv = (pulseEnv / cyl) * (0.35 + this.load * 0.9);

      // Idle lope: extra AM at ~half crank for cross-plane
      const lope = 1 + e.lopeDepth * Math.sin(2 * Math.PI * crankHz * 0.5 * t * 0 + this._combustPhase * Math.PI) * (1 - rpmN * 0.7);
      // Use phase-based lope
      const lopeAm = 1 + e.lopeDepth * 0.65 * Math.sin(this._combustPhase * Math.PI) * (rpmN < 0.25 ? 1 : 0.35);

      const bodyAmp = (0.1 + this.load * 0.28 + rpmN * 0.08) * lopeAm * e.fundMul;
      const coastQuiet = this.load < 0.2 ? 0.55 + this.load : 1;

      // Harmonic amplitudes vs RPM/load
      for (let i = 0; i < this._harmonics.length; i++) {
        const { osc, g, bp, h } = this._harmonics[i];
        const freq = fireHz * (h * 0.5) * e.fundMul + crankHz * (h === 1 ? 0.5 : 0);
        // Better: harmonic of combustion fundamental
        const f0 = Math.max(40, fireHz * 0.5); // half-order / engine order mix
        const freqH = f0 * h * (0.98 + (h % 3) * 0.01);
        osc.frequency.setTargetAtTime(clamp(freqH, 30, 12000), t, 0.02);
        bp.frequency.setTargetAtTime(clamp(freqH * 1.1, 60, 10000), t, 0.04);

        // Higher harmonics grow with RPM and load (exhaust scream)
        const harmRoll =
          (1 / Math.pow(h, 0.65)) *
          (h <= 2 ? 1.1 : e.harmBright * (0.4 + rpmN * 1.2)) *
          (0.5 + this.load * 0.7);
        const amp = bodyAmp * harmRoll * pulseEnv * 0.45 * coastQuiet;
        g.gain.setTargetAtTime(amp, t, 0.02);
      }

      // Body oscillators track RPM more musically
      const bodyF = Math.max(45, crankHz * 2 * e.fundMul + 28);
      this._body.frequency.setTargetAtTime(bodyF, t, 0.025);
      this._body2.frequency.setTargetAtTime(bodyF * 1.498, t, 0.03);
      this._bodyGain.gain.setTargetAtTime(0.07 * bodyAmp * coastQuiet, t, 0.03);
      this._body2Gain.gain.setTargetAtTime(0.045 * bodyAmp * e.harmBright * coastQuiet, t, 0.03);

      // Sub rumble
      this._sub.frequency.setTargetAtTime(Math.max(32, crankHz * e.fundMul), t, 0.04);
      this._subGain.gain.setTargetAtTime(
        (0.1 + this.load * 0.2) * e.rumble * (0.75 + (1 - rpmN) * 0.4) * lopeAm,
        t,
        0.05
      );

      // Lope tone at low rpm
      this._lope.frequency.setTargetAtTime(Math.max(8, crankHz * 0.5), t, 0.05);
      this._lopeGain.gain.setTargetAtTime(
        e.lopeDepth * 0.06 * (1 - rpmN) * (0.5 + this.load),
        t,
        0.08
      );

      // Exhaust noise: louder on load, more open (higher) on overrun
      const exOpen = this.load < 0.2 ? 1.35 : 1;
      this._exFilter.frequency.setTargetAtTime(
        (320 + rpmN * 1600 + this.load * 500) * exOpen,
        t,
        0.05
      );
      this._exFilter2.frequency.setTargetAtTime(1400 + rpmN * 3200 + this.load * 800, t, 0.05);
      this._exGain.gain.setTargetAtTime(
        (0.03 + this.load * 0.12 + rpmN * 0.05 + (this.load < 0.15 ? 0.04 : 0)) *
          e.exhaust *
          coastQuiet,
        t,
        0.04
      );

      // Intake: strong with throttle, almost gone on coast
      this._inFilter.frequency.setTargetAtTime(900 + rpmN * 2400 + this.load * 1200, t, 0.04);
      this._inGain.gain.setTargetAtTime(
        Math.pow(this.load, 1.2) * (0.02 + rpmN * 0.04) * e.intake,
        t,
        0.03
      );

      // Master filter opens with revs/load; closes a bit on coast for "engine braking" darkness
      const cut =
        450 +
        rpmN * 3200 +
        this.load * 1400 -
        (this.load < 0.2 ? 400 : 0);
      this._lp.frequency.setTargetAtTime(clamp(cut, 300, 9000), t, 0.05);

      // Near redline: add harshness
      if (this.rpm > e.redline * 0.96) {
        this._exGain.gain.setTargetAtTime(0.16 * e.exhaust, t, 0.02);
        this._harmonics[5] &&
          this._harmonics[5].g.gain.setTargetAtTime(0.08 * e.harmBright, t, 0.02);
      }

      this._tick = requestAnimationFrame(() => this._loop());
    }
  }

  global.EngineSynth = EngineSynth;
  global.ENGINE_PRESETS = ENGINES;
})(window);
