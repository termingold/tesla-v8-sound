/**
 * Pulse-driven V8 — BufferSource impulse loop + oscillators.
 * Sample mode: user-provided V8 drive clip (primary) + optional CC0 rev one-shot.
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
      idleRpm: 780,
      redline: 5200,
      gears: 6,
      cylWeights: [1.0, 0.42, 0.95, 0.38, 1.05, 0.4, 0.9, 0.45],
      fireFrac: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875],
      toneBright: 0.4,
      rumble: 1.0,
      crackle: 0.8,
      // Matching user clip: upshifts ~3500–3800 under pull
      shiftRpmHigh: 3800,
      shiftRpmLow: 3000,
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
      shiftRpmHigh: 7200,
      shiftRpmLow: 5500,
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
      shiftRpmHigh: 6200,
      shiftRpmLow: 4800,
    },
  };

  // Ratios chosen so 1→2 drop ≈ 0.55 (clip: ~3600→1950)
  const GEAR_RATIOS = [0, 3.9, 2.15, 1.48, 1.12, 0.88, 0.7, 0.58];
  const FINAL_DRIVE = 3.73;
  const WHEEL_RADIUS = 0.35;

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function gearDropFactor(fromGear, toGear) {
    const a = GEAR_RATIOS[fromGear] || 1;
    const b = GEAR_RATIOS[toGear] || 1;
    if (a <= 0) return 1;
    return clamp(b / a, 0.45, 1.55);
  }

  /** One 4-stroke cycle of uneven combustion pulses (procedural, no samples). */
  function makePulseCycleBuffer(ctx, engine) {
    const idle = engine.idleRpm;
    const dur = 120 / idle;
    const sr = ctx.sampleRate;
    const n = Math.max(2048, Math.floor(sr * dur));
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const cyl = engine.cylinders;
    const decaySamples = Math.floor(sr * 0.012);

    for (let c = 0; c < cyl; c++) {
      const start = Math.floor((engine.fireFrac[c] % 1) * n);
      const amp = (engine.cylWeights[c] || 1) * 0.9;
      for (let i = 0; i < decaySamples; i++) {
        const idx = (start + i) % n;
        const t = i / sr;
        const env = Math.exp(-t * 180) - Math.exp(-t * 900);
        const tone =
          Math.sin(2 * Math.PI * 90 * t) * 0.7 +
          Math.sin(2 * Math.PI * 180 * t) * 0.35 +
          Math.sin(2 * Math.PI * 270 * t) * 0.15 * engine.toneBright;
        d[idx] += amp * env * tone;
      }
    }
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
      this.soundMode = 'sample'; // default: user V8 sample
      this.rpm = 780;
      this.targetRpm = 780;
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
      this._shiftFreezeUntil = 0;
      this.lastError = null;
      this.audioState = 'idle';
      this._sampleIdleBuf = null;
      this._sampleRevBuf = null;
      this._samplesLoading = null;
      this._lastRevShot = 0;
      // Home RPM of user_v8_drive.ogg (mid-pull character from analysis)
      this._sampleBaseRpm = 2100;
      this._startLock = null;
      this._sampleReady = false;
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

    async setSoundMode(mode) {
      const next = mode === 'sample' ? 'sample' : 'synth';
      if (next === this.soundMode) return;
      const was = this.running;
      const demo = this.demoActive;
      if (was) this.stop();
      this.soundMode = next;
      if (was) {
        await this.start();
        if (demo) this.playDemoDrive();
      }
    }

    async loadSamples() {
      if (this._sampleIdleBuf) {
        this._sampleReady = true;
        return true;
      }
      if (this._samplesLoading) return this._samplesLoading;
      this._samplesLoading = (async () => {
        await this.ensureContext();
        const loadOne = async (rel) => {
          const url = new URL(rel, document.baseURI).href;
          const res = await fetch(url, { cache: 'force-cache' });
          if (!res.ok) throw new Error('Sample fehlt: ' + url);
          const arr = await res.arrayBuffer();
          return await this.ctx.decodeAudioData(arr.slice(0));
        };
        // Primary: user-provided V8 drive clip
        this._sampleIdleBuf = await loadOne('samples/user_v8_drive.ogg');
        // Optional rev one-shot (CC0); ignore failure
        try {
          this._sampleRevBuf = await loadOne('samples/henaway_v8_rev.ogg');
        } catch (_) {
          this._sampleRevBuf = null;
        }
        this._sampleReady = true;
        return true;
      })().catch((err) => {
        this._samplesLoading = null;
        this._sampleReady = false;
        this.lastError = String(err && err.message ? err.message : err);
        throw err;
      });
      return this._samplesLoading;
    }

    async ensureContext() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) throw new Error('Web Audio API fehlt in diesem Browser');
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      this.audioState = this.ctx.state;
      return this.ctx;
    }

    async start() {
      if (this._startLock) return this._startLock;
      this.lastError = null;
      this._startLock = (async () => {
        try {
          await this.ensureContext();
          if (this.soundMode === 'sample') {
            try {
              await this.loadSamples();
            } catch (err) {
              // Fallback to synth if sample fails
              this.soundMode = 'synth';
              this.lastError =
                'Sample-Laden fehlgeschlagen, Synth-Fallback: ' +
                (err && err.message ? err.message : err);
            }
          }
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
          this.load = 0.18;
          this.gear = Math.min(this.gear || 1, this.maxGear);
          if (this.gear < 1) this.gear = 1;
          this._lastT = this.ctx.currentTime;
          this._applyVoice(true);
          this._startClick();
          this.audioState = this.ctx.state;
          this._tick = requestAnimationFrame(() => this._loop());
        } catch (err) {
          this.lastError = String(err && err.message ? err.message : err);
          this.audioState = this.ctx ? this.ctx.state : 'error';
          throw err;
        } finally {
          this._startLock = null;
        }
      })();
      return this._startLock;
    }

    stop() {
      this.stopDemo();
      this.running = false;
      if (this._tick) cancelAnimationFrame(this._tick);
      this._tick = null;
      this._teardown();
      this.audioState = this.ctx ? this.ctx.state : 'stopped';
    }

    async setEngine(id) {
      if (!ENGINES[id]) return;
      const was = this.running;
      const demo = this.demoActive;
      if (was) this.stop();
      this.engineId = id;
      this.rpm = ENGINES[id].idleRpm;
      this.targetRpm = this.rpm;
      this.gear = 1;
      this.manualShift = false;
      this.shiftHoldUntil = 0;
      this._shifting = false;
      this._shiftFreezeUntil = 0;
      if (was) {
        await this.start();
        if (demo) this.playDemoDrive();
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
      this.load = load;

      // Hold audible RPM drop/rise during shift; don't overwrite immediately
      if (this._shifting || now < this._shiftFreezeUntil) {
        return;
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
        return;
      }
      this.targetRpm = clamp(rpm, e.idleRpm * 0.9, e.redline * 1.02);
    }

    setRev(amount) {
      if (this.demoActive) return;
      const e = this.engine;
      const prev = this.load;
      const a = clamp(amount, 0, 1);
      if (a <= 0.02) {
        this.load = 0.18;
        this.targetRpm = e.idleRpm;
        return;
      }
      this.load = a;
      this.targetRpm = e.idleRpm + (e.redline - e.idleRpm) * Math.pow(this.load, 0.82);
      if (this.soundMode === 'sample' && this.load > 0.55 && this.load - prev > 0.12) {
        this._fireRevSample();
      }
    }

    shiftUp() {
      this._doUpshift(false);
    }
    shiftDown() {
      this._doDownshift();
    }

    _autoGear(speed, load, e) {
      const high = e.shiftRpmHigh || e.redline * 0.9;
      const low = e.shiftRpmLow || e.redline * 0.55;
      const shiftRpm = load > 0.7 ? high : low + (high - low) * clamp((load - 0.2) / 0.5, 0, 1);
      const downRpm = e.idleRpm * 1.45;
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
        for (let i = 1; i <= this.maxGear; i++) if (speed >= bands[i - 1]) g = i;
        if (!this._shifting && Math.abs(g - this.gear) >= 2) {
          if (g > this.gear) this._doUpshift(true);
          else this._doDownshift(true);
        }
      }
    }

    _doUpshift(auto) {
      if (this.gear >= this.maxGear) return;
      // Auto-shifts debounce; manual +/- always applies so buttons feel responsive
      if (auto && this._shifting) return;
      const from = this.gear;
      this._shifting = true;
      this.gear++;
      const factor = gearDropFactor(from, this.gear);
      if (!auto) {
        this.manualShift = true;
        this.shiftHoldUntil = performance.now() + 2200;
      }
      // Audible RPM drop matching clip (~45% on 1→2)
      const dropped = Math.max(this.engine.idleRpm, this.rpm * factor);
      this.rpm = dropped;
      this.targetRpm = dropped;
      this._shiftFreezeUntil = performance.now() + (auto ? 220 : 280);
      clearTimeout(this._shiftUnlockTimer);
      this._shiftUnlockTimer = setTimeout(() => {
        this._shifting = false;
      }, auto ? 160 : 90);
    }

    _doDownshift(auto) {
      if (this.gear <= 1) return;
      if (auto && this._shifting) return;
      const from = this.gear;
      this._shifting = true;
      this.gear--;
      const factor = gearDropFactor(from, this.gear);
      if (!auto) {
        this.manualShift = true;
        this.shiftHoldUntil = performance.now() + 2200;
      }
      const risen = Math.min(this.engine.redline * 0.94, this.rpm * factor);
      this.rpm = risen;
      this.targetRpm = risen;
      this._fireCrackle(3);
      this._shiftFreezeUntil = performance.now() + (auto ? 200 : 260);
      clearTimeout(this._shiftUnlockTimer);
      this._shiftUnlockTimer = setTimeout(() => {
        this._shifting = false;
      }, auto ? 160 : 90);
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
        { t: 6.8, rpm: 2800, load: 1.0, gear: 1, speed: 30 },
        { t: 8.0, rpm: 3600, load: 1.0, gear: 1, speed: 55 },
        { t: 8.2, rpm: 2000, load: 0.95, gear: 2, speed: 60 },
        { t: 9.5, rpm: 3500, load: 1.0, gear: 2, speed: 95 },
        { t: 9.7, rpm: 2100, load: 0.95, gear: 3, speed: 100 },
        { t: 11.0, rpm: 3400, load: 0.9, gear: 3, speed: 130 },
        { t: 11.5, rpm: e.redline * 0.45, load: 0.05, gear: 3, speed: 125, crackle: true },
        { t: 13.0, rpm: e.idleRpm * 2, load: 0.12, gear: 2, speed: 40 },
        { t: 14.0, rpm: 3600, load: 1.0, gear: 2, speed: 70 },
        { t: 16.0, rpm: 2600, load: 0.6, gear: 3, speed: 110 },
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
      this._demoSpeed = 0;
      if (this.running) {
        this.load = 0.18;
        this.targetRpm = this.engine.idleRpm;
      }
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

      this._thump.connect(this._bark);
      this._bark.connect(this._lp);
      this._lp.connect(this._hp);
      this._hp.connect(this._master);
      this._master.connect(ctx.destination);

      this._crackleBuf = makeCrackleBuffer(ctx);
      this._prevLoad = 0.2;

      if (this.soundMode === 'sample' && this._sampleIdleBuf) {
        this._buildSampleGraph(ctx);
      } else {
        this.soundMode = this.soundMode === 'sample' && !this._sampleIdleBuf ? 'synth' : this.soundMode;
        this._buildSynthGraph(ctx, e);
      }
    }

    _buildSynthGraph(ctx, e) {
      this._pulseGain = ctx.createGain();
      this._pulseGain.gain.value = 0.7;
      this._bodyGain = ctx.createGain();
      this._bodyGain.gain.value = 0.2;

      this._pulseBuf = makePulseCycleBuffer(ctx, e);
      this._pulse = ctx.createBufferSource();
      this._pulse.buffer = this._pulseBuf;
      this._pulse.loop = true;
      this._pulse.playbackRate.value = 1;
      this._pulse.connect(this._pulseGain);
      this._pulseGain.connect(this._thump);

      this._body = ctx.createOscillator();
      this._body.type = 'sawtooth';
      this._body.frequency.value = 70;
      this._body.connect(this._bodyGain);

      this._sub = ctx.createOscillator();
      this._sub.type = 'sine';
      this._subGain = ctx.createGain();
      this._subGain.gain.value = 0.15;
      this._sub.connect(this._subGain);

      this._bodyGain.connect(this._lp);
      this._subGain.connect(this._lp);

      this._pulse.start();
      this._body.start();
      this._sub.start();
    }

    _buildSampleGraph(ctx) {
      this._pulseGain = ctx.createGain();
      this._pulseGain.gain.value = 0.9;
      this._sampleGain = ctx.createGain();
      this._sampleGain.gain.value = 1.0;

      this._pulse = ctx.createBufferSource();
      this._pulse.buffer = this._sampleIdleBuf;
      this._pulse.loop = true;
      // Soft loop edges when supported
      try {
        const n = this._sampleIdleBuf.length;
        const sr = this._sampleIdleBuf.sampleRate;
        this._pulse.loopStart = 0.05;
        this._pulse.loopEnd = Math.max(0.5, n / sr - 0.05);
      } catch (_) {}
      const startRate = clamp(this.rpm / this._sampleBaseRpm, 0.45, 2.2);
      this._pulse.playbackRate.value = startRate;
      this._pulse.connect(this._sampleGain);
      this._sampleGain.connect(this._pulseGain);
      this._pulseGain.connect(this._thump);

      this._sub = ctx.createOscillator();
      this._sub.type = 'sine';
      this._subGain = ctx.createGain();
      this._subGain.gain.value = 0.05;
      this._sub.connect(this._subGain);
      this._subGain.connect(this._lp);

      this._pulse.start();
      this._sub.start();
    }

    _fireRevSample() {
      if (this.soundMode !== 'sample' || !this.ctx || !this._sampleRevBuf || !this._master) return;
      const now = this.ctx.currentTime;
      if (now - this._lastRevShot < 1.2) return;
      this._lastRevShot = now;
      const src = this.ctx.createBufferSource();
      src.buffer = this._sampleRevBuf;
      const rate = clamp(this.rpm / this._sampleBaseRpm, 0.75, 1.7);
      src.playbackRate.value = rate;
      const g = this.ctx.createGain();
      g.gain.value = 0.28 + this.load * 0.4;
      src.connect(g);
      g.connect(this._master);
      src.start(now);
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
      this._sampleGain = null;
    }

    _applyVoice(immediate) {
      if (!this.ctx || !this._pulse) return;
      const e = this.engine;
      const t = this.ctx.currentTime;
      const tc = immediate ? 0.01 : 0.045;
      const rpmN = clamp((this.rpm - e.idleRpm) / (e.redline - e.idleRpm), 0, 1.05);

      if (this.soundMode === 'sample') {
        // Pitch follows RPM; freeze slightly snappier during shift for audible drop
        const rateTc = this._shifting ? 0.02 : tc;
        const rate = clamp(this.rpm / this._sampleBaseRpm, 0.45, 2.2);
        this._pulse.playbackRate.setTargetAtTime(rate, t, rateTc);
        const amp = (0.6 + this.load * 0.45) * (this.load < 0.12 ? 0.88 : 1);
        this._pulseGain.gain.setTargetAtTime(amp, t, tc);
        if (this._sub && this._subGain) {
          this._sub.frequency.setTargetAtTime(Math.max(35, this.rpm / 60), t, tc);
          this._subGain.gain.setTargetAtTime(
            (0.03 + this.load * 0.07) * (1 - rpmN * 0.35),
            t,
            tc
          );
        }
        const cut = 1400 + rpmN * 3200 + this.load * 1000;
        this._lp.frequency.setTargetAtTime(clamp(cut, 800, 7000), t, tc);
        this._bark.gain.setTargetAtTime(1.5 + this.load * 4, t, tc);
        this._thump.gain.setTargetAtTime(4 + (1 - rpmN) * 3, t, tc);
        return;
      }

      const rate = clamp(this.rpm / e.idleRpm, 0.5, e.redline / e.idleRpm);
      this._pulse.playbackRate.setTargetAtTime(rate, t, tc);

      const pulseAmp =
        (0.45 + this.load * 0.5) * (0.85 + e.rumble * 0.2) * (this.load < 0.15 ? 0.75 : 1);
      this._pulseGain.gain.setTargetAtTime(pulseAmp, t, tc);

      const fireHz = (this.rpm / 60) * (e.cylinders / 2);
      const bodyF = Math.max(55, fireHz * 0.5);
      if (this._body && this._bodyGain) {
        this._body.frequency.setTargetAtTime(bodyF, t, tc);
        this._bodyGain.gain.setTargetAtTime(
          (0.04 + this.load * 0.14) * (0.5 + rpmN * 0.6) * e.toneBright,
          t,
          tc
        );
      }

      if (this._sub && this._subGain) {
        this._sub.frequency.setTargetAtTime(Math.max(35, this.rpm / 60), t, tc);
        this._subGain.gain.setTargetAtTime(
          (0.08 + this.load * 0.1) * e.rumble * (1 - rpmN * 0.4),
          t,
          tc
        );
      }

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

      // Snappier RPM tracking during/after shift so drop is felt
      const lag = this._shifting ? 0.025 : this.load > 0.5 ? 0.05 : 0.11;
      this.rpm += (this.targetRpm - this.rpm) * Math.min(1, dt / lag);
      this.rpm = clamp(this.rpm, this.engine.idleRpm * 0.85, this.engine.redline * 1.05);

      const dLoad = this._prevLoad - this.load;
      if (dLoad > 0.28 && this.rpm > this.engine.idleRpm * 1.5) {
        this._fireCrackle(2 + Math.floor(dLoad * 6));
      }
      if (this.soundMode === 'sample' && this.load - this._prevLoad > 0.35 && this.load > 0.7) {
        this._fireRevSample();
      }
      this._prevLoad = this.load;
      this._applyVoice(false);

      this._tick = requestAnimationFrame(() => this._loop());
    }
  }

  global.EngineSynth = EngineSynth;
  global.ENGINE_PRESETS = ENGINES;
})(window);
