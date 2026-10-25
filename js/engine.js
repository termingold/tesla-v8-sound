/**
 * Procedural engine synthesizer (original work).
 * Sonic targets characterized from public YouTube V8 demos (URLs in README) —
 * we do NOT download or embed YouTube audio. Pure Web Audio synthesis only.
 *
 * Primary target: American cross-plane muscle V8
 * (Mustang 5.0 Coyote–style idle lope + midrange bark + Hellcat-style overrun crackle).
 */
(function (global) {
  'use strict';

  const ENGINES = {
    // Primary: YouTube muscle profile (Coyote / LT2 / Hellcat character notes)
    'v8-cross': {
      id: 'v8-cross',
      nameDe: 'V8 Muscle (Cross-Plane)',
      cylinders: 8,
      idleRpm: 750,
      redline: 7500,
      gears: 6,
      // Strong bank unevenness → classic US V8 burble / lope
      cylWeights: [1.15, 0.55, 1.1, 0.5, 1.05, 0.58, 1.2, 0.52],
      fireDeg: [0, 90, 180, 270, 360, 450, 540, 630],
      fundMul: 0.92,
      harmBright: 0.55,
      rumble: 1.25,
      intake: 0.7,
      exhaust: 1.15,
      crackle: 1.0,
      lopeDepth: 0.85,
      bark: 1.0, // midrange growl under load
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
      harmBright: 0.9,
      rumble: 0.3,
      intake: 0.85,
      exhaust: 0.7,
      crackle: 0.75,
      lopeDepth: 0.06,
      bark: 0.45,
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
      crackle: 0.45,
      lopeDepth: 0.1,
      bark: 0.35,
      tone: 'smooth',
    },
  };

  const GEAR_RATIOS = [0, 3.6, 2.25, 1.55, 1.18, 0.92, 0.74, 0.62];
  const FINAL_DRIVE = 3.73;
  const WHEEL_RADIUS = 0.35;

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
    const k = amount;
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
      this.rpm = 750;
      this.targetRpm = 750;
      this.load = 0.12;
      this.volume = 0.6;
      this.gear = 1;
      this.manualShift = false;
      this.shiftHoldUntil = 0;
      this.demoActive = false;
      this._demoTimer = null;
      this._demoSpeed = 0;

      this._tick = null;
      this._lastT = 0;
      this._prevLoad = 0.2;
      this._crackleNext = 0;
      this._shifting = false;
      this._combustPhase = 0;
      this._harmonics = [];
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
      this.load = 0.14;
      this.gear = 1;
      this._lastT = this.ctx.currentTime;
      this._combustPhase = 0;
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
        this._outGain.gain.setTargetAtTime(this.volume * 0.95, this.ctx.currentTime, 0.05);
      }
    }

    updateFromTelemetry(speedKmh, accelHint) {
      if (this.demoActive) return;
      const e = this.engine;
      const speed = Math.max(0, speedKmh || 0);
      const now = performance.now();

      let load;
      if (typeof accelHint === 'number' && !Number.isNaN(accelHint)) {
        load = clamp(0.12 + accelHint * 0.95, 0.02, 1);
      } else {
        load = speed < 2 ? 0.14 : clamp(0.28 + speed / 200, 0.22, 0.75);
      }

      if (!this.manualShift || now > this.shiftHoldUntil) {
        this.manualShift = false;
        this._autoGear(speed, load, e);
      }

      const wheelRpm =
        speed > 0.5 ? ((speed / 3.6) / (2 * Math.PI * WHEEL_RADIUS)) * 60 : 0;
      const ratio = GEAR_RATIOS[this.gear] || 1.5;
      let rpm = wheelRpm * ratio * FINAL_DRIVE;

      if (speed < 1.2) rpm = e.idleRpm * (1 + load * 0.2);
      else if (load < 0.2) rpm *= 0.9;
      else rpm *= 1 + load * 0.07;

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
      this.targetRpm = e.idleRpm + (e.redline - e.idleRpm) * Math.pow(this.load, 0.8);
    }

    shiftUp() {
      this._doUpshift(false);
    }
    shiftDown() {
      this._doDownshift();
    }

    _autoGear(speed, load, e) {
      const shiftRpm = load > 0.7 ? e.redline * 0.9 : e.redline * (0.52 + load * 0.32);
      const downRpm = e.idleRpm * 1.4;
      const wheelRpm =
        speed > 0.5 ? ((speed / 3.6) / (2 * Math.PI * WHEEL_RADIUS)) * 60 : 0;
      const rpmNow = wheelRpm * (GEAR_RATIOS[this.gear] || 1.5) * FINAL_DRIVE;

      if (rpmNow > shiftRpm && this.gear < this.maxGear && load > 0.15) {
        this._doUpshift(true);
      } else if (rpmNow < downRpm && this.gear > 1 && speed > 3) {
        this._doDownshift(true);
      } else {
        let g = 1;
        const bands = [0, 18, 38, 58, 85, 115, 150, 200];
        for (let i = 1; i <= this.maxGear; i++) {
          if (speed >= bands[i - 1]) g = i;
        }
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
      this._shiftThump(false);
      setTimeout(() => {
        this._shifting = false;
      }, 180);
    }

    _doDownshift(auto) {
      if (this.gear <= 1 || this._shifting) return;
      this._shifting = true;
      this.gear--;
      if (!auto) {
        this.manualShift = true;
        this.shiftHoldUntil = performance.now() + 2200;
      }
      this.targetRpm = Math.min(this.engine.redline * 0.94, this.rpm * 1.4);
      this.rpm = Math.min(this.engine.redline * 0.95, this.rpm * 1.34);
      this._shiftThump(true);
      this._scheduleCrackles(4 + Math.floor(Math.random() * 4), 0.045);
      setTimeout(() => {
        this._shifting = false;
      }, 220);
    }

    _shiftThump(down) {
      if (!this.ctx || !this._crackGain) return;
      const t = this.ctx.currentTime;
      if (down) {
        this.load = Math.min(1, this.load + 0.55);
        setTimeout(() => {
          if (!this.demoActive) this.load = Math.max(0.05, this.load - 0.4);
        }, 90);
      }
      this._crackGain.gain.cancelScheduledValues(t);
      this._crackGain.gain.setValueAtTime(0.001, t);
      this._crackGain.gain.linearRampToValueAtTime(down ? 0.65 : 0.3, t + 0.012);
      this._crackGain.gain.exponentialRampToValueAtTime(0.001, t + (down ? 0.16 : 0.08));
    }

    _scheduleCrackles(count, spacing) {
      if (!this.ctx || !this._crackGain) return;
      const t0 = this.ctx.currentTime;
      const strength = this.engine.crackle;
      for (let i = 0; i < count; i++) {
        const t = t0 + i * (spacing + Math.random() * 0.05);
        const amp = (0.22 + Math.random() * 0.45) * strength;
        this._crackGain.gain.setValueAtTime(0.001, t);
        this._crackGain.gain.linearRampToValueAtTime(amp, t + 0.006);
        this._crackGain.gain.exponentialRampToValueAtTime(0.001, t + 0.035 + Math.random() * 0.06);
      }
    }

    /**
     * Demo tuned to showcase muscle character:
     * long idle lope → blip → full launch bark → shifts → big lift-off crackle → kickdown.
     */
    playDemoDrive() {
      this.stopDemo();
      if (!this.running) return;
      this.demoActive = true;
      const e = this.engine;
      const steps = [
        // Long idle so lope is obvious (YouTube cold-start / idle vibe)
        { t: 0, rpm: e.idleRpm, load: 0.16, gear: 1, speed: 0 },
        { t: 2.8, rpm: e.idleRpm * 1.05, load: 0.18, gear: 1, speed: 0 },
        // Free rev blip
        { t: 3.2, rpm: e.redline * 0.45, load: 0.9, gear: 1, speed: 0 },
        { t: 3.7, rpm: e.idleRpm * 1.1, load: 0.12, gear: 1, speed: 0, crackle: 3 },
        // Launch
        { t: 4.4, rpm: e.redline * 0.55, load: 1.0, gear: 1, speed: 25 },
        { t: 5.6, rpm: e.redline * 0.95, load: 1.0, gear: 1, speed: 55 },
        { t: 5.75, rpm: e.redline * 0.62, load: 0.98, gear: 2, speed: 60, up: true },
        { t: 7.0, rpm: e.redline * 0.92, load: 1.0, gear: 2, speed: 95 },
        { t: 7.15, rpm: e.redline * 0.6, load: 0.95, gear: 3, speed: 100, up: true },
        { t: 8.5, rpm: e.redline * 0.88, load: 1.0, gear: 3, speed: 135 },
        { t: 8.65, rpm: e.redline * 0.58, load: 0.92, gear: 4, speed: 140, up: true },
        { t: 9.8, rpm: e.redline * 0.72, load: 0.85, gear: 4, speed: 155 },
        // Aggressive lift-off / overrun (Hellcat/AMG pops character)
        { t: 10.3, rpm: e.redline * 0.55, load: 0.04, gear: 4, speed: 150, crackle: 8 },
        { t: 11.2, rpm: e.redline * 0.42, load: 0.05, gear: 3, speed: 120, down: true },
        { t: 12.3, rpm: e.redline * 0.48, load: 0.06, gear: 2, speed: 75, down: true },
        { t: 13.4, rpm: e.idleRpm * 2.0, load: 0.1, gear: 2, speed: 40 },
        // Kickdown overtake bark
        { t: 14.0, rpm: e.redline * 0.88, load: 1.0, gear: 2, speed: 60, down: true },
        { t: 15.4, rpm: e.redline * 0.96, load: 1.0, gear: 2, speed: 105 },
        { t: 15.55, rpm: e.redline * 0.64, load: 0.95, gear: 3, speed: 110, up: true },
        { t: 17.0, rpm: e.redline * 0.78, load: 0.75, gear: 3, speed: 130 },
        { t: 18.2, rpm: e.redline * 0.35, load: 0.05, gear: 3, speed: 70, crackle: 6 },
        { t: 20.0, rpm: e.idleRpm * 1.3, load: 0.14, gear: 1, speed: 15 },
        { t: 21.5, rpm: e.idleRpm, load: 0.15, gear: 1, speed: 0 },
        { t: 22.5, rpm: e.idleRpm, load: 0.14, gear: 1, speed: 0, end: true },
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
          this._scheduleCrackles(4, 0.05);
        }
        if (a.crackle && !a._cr) {
          a._cr = true;
          this._scheduleCrackles(a.crackle, 0.055);
        }
        if (a.end || elapsed > 23) {
          this.demoActive = false;
          this.load = 0.14;
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
      this._outGain.gain.value = this.volume * 0.95;

      this._master = ctx.createGain();
      this._master.gain.value = 1;

      this._lp = ctx.createBiquadFilter();
      this._lp.type = 'lowpass';
      this._lp.frequency.value = 900;
      this._lp.Q.value = 0.75;

      this._hp = ctx.createBiquadFilter();
      this._hp.type = 'highpass';
      this._hp.frequency.value = 28;
      this._hp.Q.value = 0.5;

      // Deep chest / burble (muscle)
      this._midLow = ctx.createBiquadFilter();
      this._midLow.type = 'peaking';
      this._midLow.frequency.value = e.tone === 'sport' ? 220 : 160;
      this._midLow.Q.value = 0.85;
      this._midLow.gain.value = e.tone === 'muscle' ? 9 : 5;

      // Midrange "bark" under load (Coyote growl hardens)
      this._bark = ctx.createBiquadFilter();
      this._bark.type = 'peaking';
      this._bark.frequency.value = e.tone === 'sport' ? 1100 : 520;
      this._bark.Q.value = 1.2;
      this._bark.gain.value = 3;

      this._presence = ctx.createBiquadFilter();
      this._presence.type = 'peaking';
      this._presence.frequency.value = e.tone === 'sport' ? 3200 : 1800;
      this._presence.Q.value = 1.0;
      this._presence.gain.value = e.harmBright * 4;

      this._shaper = ctx.createWaveShaper();
      this._shaper.curve = makeDistortion(18 + e.rumble * 32);
      this._shaper.oversample = '2x';

      // Harmonic bank — more lows for muscle
      this._harmonics = [];
      for (let h = 1; h <= 8; h++) {
        const osc = ctx.createOscillator();
        osc.type = h === 1 ? 'sawtooth' : h === 2 ? 'square' : h === 3 ? 'sawtooth' : 'triangle';
        const g = ctx.createGain();
        g.gain.value = 0;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 70 * h;
        bp.Q.value = 0.7 + h * 0.12;
        osc.connect(bp);
        bp.connect(g);
        g.connect(this._lp);
        osc.start();
        this._harmonics.push({ osc, g, bp, h });
      }

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

      // Extra "cam lope" sub pulse
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
      this._lope.connect(this._lopeGain);
      this._lopeGain.connect(this._master);
      this._sub.start();
      this._lope.start();

      const pink = makeNoiseBuffer(ctx, 3, 'pink');
      const white = makeNoiseBuffer(ctx, 2, 'white');

      this._exNoise = ctx.createBufferSource();
      this._exNoise.buffer = pink;
      this._exNoise.loop = true;
      this._exFilter = ctx.createBiquadFilter();
      this._exFilter.type = 'bandpass';
      this._exFilter.frequency.value = 380;
      this._exFilter.Q.value = 0.5;
      this._exFilter2 = ctx.createBiquadFilter();
      this._exFilter2.type = 'lowpass';
      this._exFilter2.frequency.value = 1800;
      this._exGain = ctx.createGain();
      this._exGain.gain.value = 0;
      this._exNoise.connect(this._exFilter);
      this._exFilter.connect(this._exFilter2);
      this._exFilter2.connect(this._exGain);
      this._exGain.connect(this._lp);
      this._exNoise.start();

      this._inNoise = ctx.createBufferSource();
      this._inNoise.buffer = white;
      this._inNoise.loop = true;
      this._inFilter = ctx.createBiquadFilter();
      this._inFilter.type = 'bandpass';
      this._inFilter.frequency.value = 1600;
      this._inFilter.Q.value = 0.65;
      this._inGain = ctx.createGain();
      this._inGain.gain.value = 0;
      this._inNoise.connect(this._inFilter);
      this._inFilter.connect(this._inGain);
      this._inGain.connect(this._hp);
      this._inNoise.start();

      // Crackle: brighter pops
      this._crackNoise = ctx.createBufferSource();
      this._crackNoise.buffer = white;
      this._crackNoise.loop = true;
      this._crackFilt = ctx.createBiquadFilter();
      this._crackFilt.type = 'bandpass';
      this._crackFilt.frequency.value = 1400;
      this._crackFilt.Q.value = 1.6;
      this._crackGain = ctx.createGain();
      this._crackGain.gain.value = 0;
      this._crackNoise.connect(this._crackFilt);
      this._crackFilt.connect(this._crackGain);
      this._crackGain.connect(this._master);
      this._crackNoise.start();

      this._lp.connect(this._shaper);
      this._shaper.connect(this._midLow);
      this._midLow.connect(this._bark);
      this._bark.connect(this._presence);
      this._presence.connect(this._hp);
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
        try {
          n.stop();
        } catch (_) {}
        try {
          n.disconnect();
        } catch (_) {}
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
        if (this._outGain)
          try {
            this._outGain.disconnect();
          } catch (_) {}
      } catch (_) {}
      this._harmonics = [];
    }

    _loop() {
      if (!this.running || !this.ctx) return;
      const t = this.ctx.currentTime;
      const dt = Math.min(0.05, Math.max(0.008, t - (this._lastT || t - 0.016)));
      this._lastT = t;
      const e = this.engine;

      const lag = this.load > 0.5 ? 0.05 : 0.13;
      this.rpm += (this.targetRpm - this.rpm) * Math.min(1, dt / lag);
      this.rpm = clamp(this.rpm, e.idleRpm * 0.82, e.redline * 1.06);

      const dLoad = this._prevLoad - this.load;
      if (dLoad > 0.22 && this.rpm > e.idleRpm * 1.5) {
        const n = 3 + Math.floor(dLoad * 10 * e.crackle);
        this._scheduleCrackles(n, 0.04);
      }
      if (this.load < 0.16 && this.rpm > e.idleRpm * 2.0 && t > this._crackleNext) {
        this._crackleNext = t + 0.06 + Math.random() * 0.18;
        if (Math.random() < 0.55 * e.crackle) this._scheduleCrackles(1 + (Math.random() > 0.6 ? 1 : 0), 0.025);
      }
      this._prevLoad = this.load;

      const rpmN = clamp((this.rpm - e.idleRpm) / (e.redline - e.idleRpm), 0, 1.05);
      const fireHz = (this.rpm / 60) * (e.cylinders / 2);
      const crankHz = this.rpm / 60;

      // Sharper combustion spikes + heavy cross-plane unevenness
      this._combustPhase += fireHz * dt;
      const cyl = e.cylinders;
      let pulseEnv = 0;
      for (let i = 0; i < cyl; i++) {
        const off = (e.fireDeg[i] || i * (720 / cyl)) / 720;
        const ph = (this._combustPhase + off) % 1;
        const w = e.cylWeights[i] || 1;
        // power 12 = snappier "pop" per firing (more exhaust-like than sine AM)
        const spike = Math.pow(Math.max(0, Math.cos(ph * Math.PI * 2)), 12);
        pulseEnv += spike * w;
      }
      pulseEnv = (pulseEnv / cyl) * (0.4 + this.load * 1.0);

      // Idle lope AM — very audible at low rpm (Mustang burble)
      const lopeAm =
        1 +
        e.lopeDepth *
          (0.55 * Math.sin(this._combustPhase * Math.PI) +
            0.35 * Math.sin(this._combustPhase * Math.PI * 0.5)) *
          (rpmN < 0.22 ? 1.15 : rpmN < 0.4 ? 0.55 : 0.2);

      const bodyAmp = (0.12 + this.load * 0.32 + rpmN * 0.1) * lopeAm * e.fundMul;
      const coastQuiet = this.load < 0.2 ? 0.5 + this.load * 1.2 : 1;

      for (let i = 0; i < this._harmonics.length; i++) {
        const { osc, g, bp, h } = this._harmonics[i];
        // Order tracking: fireHz fundamentals (Coyote ~67 Hz @ 1000 rpm for 4 pulses/rev → half-order mix)
        const f0 = Math.max(38, fireHz * 0.5);
        const freqH = f0 * h * (0.985 + (h % 3) * 0.008);
        osc.frequency.setTargetAtTime(clamp(freqH, 28, 11000), t, 0.018);
        bp.frequency.setTargetAtTime(clamp(freqH * 1.05, 50, 9000), t, 0.035);

        // Muscle: emphasize 1–3; bark adds 4–5 under load/mid rpm
        let harmRoll = 1 / Math.pow(h, h <= 3 ? 0.45 : 0.85);
        if (h <= 2) harmRoll *= 1.35 * e.rumble;
        else if (h <= 4) harmRoll *= e.bark * (0.5 + this.load * 1.1) * (0.4 + rpmN);
        else harmRoll *= e.harmBright * (0.25 + rpmN * 1.1) * (0.4 + this.load);
        const amp = bodyAmp * harmRoll * pulseEnv * 0.5 * coastQuiet;
        g.gain.setTargetAtTime(amp, t, 0.018);
      }

      const bodyF = Math.max(42, crankHz * 2 * e.fundMul + 22);
      this._body.frequency.setTargetAtTime(bodyF, t, 0.022);
      this._body2.frequency.setTargetAtTime(bodyF * 1.49, t, 0.028);
      this._bodyGain.gain.setTargetAtTime(0.09 * bodyAmp * coastQuiet, t, 0.025);
      this._body2Gain.gain.setTargetAtTime(0.05 * bodyAmp * e.harmBright * coastQuiet, t, 0.025);

      // Deep idle thump
      this._sub.frequency.setTargetAtTime(Math.max(28, crankHz * 0.5 * e.fundMul), t, 0.04);
      this._subGain.gain.setTargetAtTime(
        (0.14 + this.load * 0.18) * e.rumble * (0.9 + (1 - rpmN) * 0.6) * lopeAm,
        t,
        0.05
      );

      this._lope.frequency.setTargetAtTime(Math.max(6, crankHz * 0.5), t, 0.05);
      this._lopeGain.gain.setTargetAtTime(
        e.lopeDepth * 0.1 * (1 - Math.min(1, rpmN * 1.8)) * (0.6 + this.load * 0.5),
        t,
        0.07
      );

      // Dynamic bark EQ (YouTube midrange growl)
      if (this._bark) {
        const barkGain =
          (2 + this.load * 8 * e.bark + rpmN * 3 * e.bark) * (this.load > 0.25 ? 1 : 0.35);
        this._bark.gain.setTargetAtTime(barkGain, t, 0.06);
        this._bark.frequency.setTargetAtTime(420 + rpmN * 380 + this.load * 120, t, 0.08);
      }
      if (this._midLow) {
        this._midLow.gain.setTargetAtTime(
          (e.tone === 'muscle' ? 7 : 4) + e.rumble * 2 * (1 - rpmN * 0.5),
          t,
          0.08
        );
      }

      const exOpen = this.load < 0.2 ? 1.4 : 1;
      this._exFilter.frequency.setTargetAtTime((280 + rpmN * 1400 + this.load * 450) * exOpen, t, 0.05);
      this._exFilter2.frequency.setTargetAtTime(1100 + rpmN * 2800 + this.load * 900, t, 0.05);
      this._exGain.gain.setTargetAtTime(
        (0.04 + this.load * 0.15 + rpmN * 0.06 + (this.load < 0.15 ? 0.055 : 0)) *
          e.exhaust *
          coastQuiet,
        t,
        0.04
      );

      this._inFilter.frequency.setTargetAtTime(800 + rpmN * 2200 + this.load * 1400, t, 0.04);
      this._inGain.gain.setTargetAtTime(Math.pow(this.load, 1.15) * (0.025 + rpmN * 0.05) * e.intake, t, 0.03);

      const cut = 380 + rpmN * 3000 + this.load * 1600 - (this.load < 0.2 ? 450 : 0);
      this._lp.frequency.setTargetAtTime(clamp(cut, 280, 8500), t, 0.05);

      if (this.rpm > e.redline * 0.95) {
        this._exGain.gain.setTargetAtTime(0.18 * e.exhaust, t, 0.02);
        if (this._harmonics[5]) this._harmonics[5].g.gain.setTargetAtTime(0.1 * e.harmBright, t, 0.02);
      }

      this._tick = requestAnimationFrame(() => this._loop());
    }
  }

  global.EngineSynth = EngineSynth;
  global.ENGINE_PRESETS = ENGINES;
})(window);
