/**
 * Procedural V8 engine synthesizer (original work).
 * Cross-plane and flat-plane crank styles via Web Audio API.
 * No copyrighted samples.
 */
(function (global) {
  'use strict';

  const ENGINES = {
    'v8-cross': {
      id: 'v8-cross',
      name: 'V8 Cross-Plane',
      nameDe: 'V8 Cross-Plane',
      cylinders: 8,
      idleRpm: 700,
      redline: 6500,
      // Cross-plane: uneven bank firing → rumble / lope
      firingPattern: [0, 90, 180, 270, 360, 450, 540, 630], // degrees of crank
      unevenness: 0.22,
      baseFreq: 55,
      toneBright: 0.35,
      rumble: 0.85,
      exhaustDepth: 0.7,
    },
    'v8-flat': {
      id: 'v8-flat',
      name: 'V8 Flat-Plane',
      nameDe: 'V8 Flat-Plane',
      cylinders: 8,
      idleRpm: 900,
      redline: 8500,
      firingPattern: [0, 180, 360, 540, 90, 270, 450, 630],
      unevenness: 0.04,
      baseFreq: 70,
      toneBright: 0.65,
      rumble: 0.35,
      exhaustDepth: 0.45,
    },
    'i6-na': {
      id: 'i6-na',
      name: 'Reihensechser',
      nameDe: 'Reihensechser',
      cylinders: 6,
      idleRpm: 750,
      redline: 7200,
      firingPattern: [0, 120, 240, 360, 480, 600],
      unevenness: 0.06,
      baseFreq: 62,
      toneBright: 0.55,
      rumble: 0.4,
      exhaustDepth: 0.5,
    },
  };

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  class EngineSynth {
    constructor() {
      this.ctx = null;
      this.running = false;
      this.engineId = 'v8-cross';
      this.rpm = 700;
      this.targetRpm = 700;
      this.load = 0; // 0..1 throttle/load
      this.volume = 0.55;
      this.gear = 1;
      this.maxGear = 6;
      this.manualShift = false;
      this.shiftHoldUntil = 0;

      this._master = null;
      this._filter = null;
      this._gain = null;
      this._nodes = [];
      this._noise = null;
      this._tick = null;
      this._lastT = 0;
      this._phase = 0;
      this._cylPhases = [];
      this._popGain = null;
    }

    get engine() {
      return ENGINES[this.engineId] || ENGINES['v8-cross'];
    }

    listEngines() {
      return Object.values(ENGINES);
    }

    async ensureContext() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      return this.ctx;
    }

    async start() {
      await this.ensureContext();
      if (this.running) return;
      this._buildGraph();
      this.running = true;
      this.rpm = this.engine.idleRpm;
      this.targetRpm = this.engine.idleRpm;
      this._lastT = this.ctx.currentTime;
      this._tick = requestAnimationFrame(() => this._loop());
    }

    stop() {
      this.running = false;
      if (this._tick) cancelAnimationFrame(this._tick);
      this._tick = null;
      this._teardown();
    }

    setEngine(id) {
      if (!ENGINES[id]) return;
      const was = this.running;
      if (was) this.stop();
      this.engineId = id;
      this.rpm = ENGINES[id].idleRpm;
      this.targetRpm = this.rpm;
      this.gear = 1;
      if (was) this.start();
    }

    setVolume(v) {
      this.volume = clamp(v, 0, 1);
      if (this._gain) {
        this._gain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
      }
    }

    /** speedKmh + optional accel (-1..1 forward) drive RPM/load */
    updateFromTelemetry(speedKmh, accelHint) {
      const e = this.engine;
      const speed = Math.max(0, speedKmh || 0);
      const ratios = [0, 3.5, 2.2, 1.55, 1.15, 0.9, 0.72];
      const finalDrive = 3.7;
      const wheelRpmAt100 = 100 / (2 * Math.PI * 0.35) * 60; // ~ approx
      // target gear from speed if not holding manual
      const now = performance.now();
      if (!this.manualShift || now > this.shiftHoldUntil) {
        this.manualShift = false;
        let g = 1;
        for (let i = 1; i <= this.maxGear; i++) {
          const rpmAt = (speed / 100) * wheelRpmAt100 * ratios[i] * finalDrive;
          if (rpmAt < e.redline * 0.92 || i === 1) g = i;
          if (rpmAt > e.idleRpm * 1.15) {
            /* keep climbing */
          }
        }
        // simpler: map speed bands
        if (speed < 15) g = 1;
        else if (speed < 35) g = 2;
        else if (speed < 55) g = 3;
        else if (speed < 80) g = 4;
        else if (speed < 110) g = 5;
        else g = 6;
        this.gear = g;
      }

      const ratio = ratios[this.gear] || 1.5;
      let rpmFromSpeed = (speed / 100) * wheelRpmAt100 * ratio * finalDrive;
      if (speed < 1.5) rpmFromSpeed = e.idleRpm;

      let load = 0.15;
      if (typeof accelHint === 'number' && !Number.isNaN(accelHint)) {
        load = clamp(0.2 + accelHint * 0.9, 0.05, 1);
        // accel bumps target above speed-based rpm briefly
        rpmFromSpeed *= 1 + Math.max(0, accelHint) * 0.25;
      } else {
        // estimate load from rpm rise vs idle band
        load = clamp((rpmFromSpeed - e.idleRpm) / (e.redline - e.idleRpm), 0.1, 0.85);
      }

      this.load = load;
      this.targetRpm = clamp(rpmFromSpeed, e.idleRpm, e.redline * 1.02);
    }

    /** Parked / demo: hold-to-rev */
    setRev(amount) {
      const e = this.engine;
      this.load = clamp(amount, 0, 1);
      this.targetRpm = e.idleRpm + (e.redline - e.idleRpm) * this.load;
    }

    shiftUp() {
      if (this.gear < this.maxGear) {
        this.gear++;
        this.manualShift = true;
        this.shiftHoldUntil = performance.now() + 2500;
        this.targetRpm *= 0.72;
        this._blip(false);
      }
    }

    shiftDown() {
      if (this.gear > 1) {
        this.gear--;
        this.manualShift = true;
        this.shiftHoldUntil = performance.now() + 2500;
        this.targetRpm = Math.min(this.engine.redline * 0.95, this.targetRpm * 1.35);
        this._blip(true);
      }
    }

    _blip(down) {
      if (!this.ctx || !this._popGain) return;
      const t = this.ctx.currentTime;
      this._popGain.gain.cancelScheduledValues(t);
      this._popGain.gain.setValueAtTime(0, t);
      this._popGain.gain.linearRampToValueAtTime(down ? 0.45 : 0.25, t + 0.02);
      this._popGain.gain.exponentialRampToValueAtTime(0.001, t + (down ? 0.18 : 0.12));
    }

    _liftPop() {
      if (!this.ctx || !this._popGain || this.load > 0.25) return;
      const t = this.ctx.currentTime;
      this._popGain.gain.cancelScheduledValues(t);
      this._popGain.gain.setValueAtTime(0.001, t);
      this._popGain.gain.linearRampToValueAtTime(0.35 * this.load + 0.1, t + 0.01);
      this._popGain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    }

    _buildGraph() {
      const ctx = this.ctx;
      const e = this.engine;
      this._teardown();

      this._master = ctx.createGain();
      this._master.gain.value = 1;

      this._gain = ctx.createGain();
      this._gain.gain.value = this.volume;

      this._filter = ctx.createBiquadFilter();
      this._filter.type = 'lowpass';
      this._filter.frequency.value = 800;
      this._filter.Q.value = 0.9;

      const highShelf = ctx.createBiquadFilter();
      highShelf.type = 'highshelf';
      highShelf.frequency.value = 2400;
      highShelf.gain.value = -6 + e.toneBright * 8;

      // Cylinder pulse oscillators (saw + slight detune)
      this._cylPhases = [];
      this._nodes = [];
      for (let i = 0; i < e.cylinders; i++) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        const g = ctx.createGain();
        g.gain.value = 0;
        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        band.frequency.value = 120 + i * 18;
        band.Q.value = 1.2;
        osc.connect(band);
        band.connect(g);
        g.connect(this._filter);
        osc.start();
        this._nodes.push({ osc, g, band, offset: e.firingPattern[i] / 720 });
        this._cylPhases.push(Math.random());
      }

      // Sub rumble
      this._sub = ctx.createOscillator();
      this._sub.type = 'sine';
      this._subGain = ctx.createGain();
      this._subGain.gain.value = 0;
      this._sub.connect(this._subGain);
      this._subGain.connect(this._filter);
      this._sub.start();

      // Exhaust noise texture
      const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this._noise = ctx.createBufferSource();
      this._noise.buffer = noiseBuf;
      this._noise.loop = true;
      this._noiseFilter = ctx.createBiquadFilter();
      this._noiseFilter.type = 'bandpass';
      this._noiseFilter.frequency.value = 400;
      this._noiseFilter.Q.value = 0.6;
      this._noiseGain = ctx.createGain();
      this._noiseGain.gain.value = 0;
      this._noise.connect(this._noiseFilter);
      this._noiseFilter.connect(this._noiseGain);
      this._noiseGain.connect(this._filter);
      this._noise.start();

      // Soft clip / waveshape
      this._shaper = ctx.createWaveShaper();
      this._shaper.curve = this._makeDistortion(e.rumble * 40 + 10);
      this._shaper.oversample = '2x';

      // Pop/bang burst
      this._popOsc = ctx.createOscillator();
      this._popOsc.type = 'square';
      this._popOsc.frequency.value = 90;
      this._popGain = ctx.createGain();
      this._popGain.gain.value = 0;
      this._popNoise = ctx.createBufferSource();
      this._popNoise.buffer = noiseBuf;
      this._popNoise.loop = true;
      const popNGain = ctx.createGain();
      popNGain.gain.value = 0.6;
      this._popOsc.connect(this._popGain);
      this._popNoise.connect(popNGain);
      popNGain.connect(this._popGain);
      this._popGain.connect(this._master);
      this._popOsc.start();
      this._popNoise.start();

      this._filter.connect(this._shaper);
      this._shaper.connect(highShelf);
      highShelf.connect(this._master);
      this._master.connect(this._gain);
      this._gain.connect(ctx.destination);

      this._prevLoad = 0.2;
    }

    _makeDistortion(amount) {
      const n = 256;
      const curve = new Float32Array(n);
      const k = amount;
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
      }
      return curve;
    }

    _teardown() {
      try {
        this._nodes.forEach((n) => {
          try { n.osc.stop(); } catch (_) {}
          try { n.osc.disconnect(); } catch (_) {}
        });
        if (this._sub) try { this._sub.stop(); this._sub.disconnect(); } catch (_) {}
        if (this._noise) try { this._noise.stop(); this._noise.disconnect(); } catch (_) {}
        if (this._popOsc) try { this._popOsc.stop(); this._popOsc.disconnect(); } catch (_) {}
        if (this._popNoise) try { this._popNoise.stop(); this._popNoise.disconnect(); } catch (_) {}
        if (this._gain) try { this._gain.disconnect(); } catch (_) {}
      } catch (_) {}
      this._nodes = [];
    }

    _loop() {
      if (!this.running || !this.ctx) return;
      const t = this.ctx.currentTime;
      const dt = Math.min(0.05, t - this._lastT || 0.016);
      this._lastT = t;
      const e = this.engine;

      // Smooth RPM toward target (inertia)
      const lag = 0.08 + (1 - this.load) * 0.12;
      this.rpm += (this.targetRpm - this.rpm) * Math.min(1, dt / lag);
      this.rpm = clamp(this.rpm, e.idleRpm * 0.85, e.redline * 1.05);

      // Lift-off pops
      if (this._prevLoad - this.load > 0.35 && this.rpm > e.idleRpm * 1.8) {
        this._liftPop();
      }
      this._prevLoad = this.load;

      const firingHz = (this.rpm / 60) * (e.cylinders / 2); // 4-stroke
      const fund = firingHz / e.cylinders; // per-cylinder rate-ish
      const rpmN = (this.rpm - e.idleRpm) / (e.redline - e.idleRpm);

      // Update each cylinder pulse gain with phase-offset AM
      this._phase += firingHz * dt;
      for (let i = 0; i < this._nodes.length; i++) {
        const n = this._nodes[i];
        const uneven = 1 + e.unevenness * Math.sin(i * 1.7 + this.rpm * 0.001);
        const pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * (this._phase + n.offset) * 2);
        const amp =
          (0.04 + this.load * 0.11) *
          uneven *
          (0.35 + pulse * 0.65) *
          (0.7 + rpmN * 0.5);
        n.g.gain.setTargetAtTime(amp / Math.sqrt(e.cylinders), t, 0.02);
        const freq = e.baseFreq * (0.5 + rpmN * 2.2) * (1 + (i % 3) * 0.03);
        n.osc.frequency.setTargetAtTime(freq, t, 0.03);
        n.band.frequency.setTargetAtTime(80 + rpmN * 900 + i * 25, t, 0.05);
      }

      // Sub
      const subF = Math.max(35, e.baseFreq * 0.45 + rpmN * 40);
      this._sub.frequency.setTargetAtTime(subF, t, 0.04);
      this._subGain.gain.setTargetAtTime(
        (0.08 + this.load * 0.22) * e.rumble * (0.6 + (1 - rpmN) * 0.5),
        t,
        0.05
      );

      // Noise exhaust
      this._noiseFilter.frequency.setTargetAtTime(280 + rpmN * 1400 + this.load * 400, t, 0.05);
      this._noiseGain.gain.setTargetAtTime(
        (0.02 + this.load * 0.08 + rpmN * 0.04) * e.exhaustDepth,
        t,
        0.05
      );

      // Tone filter opens with RPM/load
      const cutoff = 500 + rpmN * 2800 + this.load * 1200;
      this._filter.frequency.setTargetAtTime(cutoff, t, 0.06);

      // Soft limiter near redline growl
      if (this.rpm > e.redline * 0.97) {
        this._noiseGain.gain.setTargetAtTime(0.12, t, 0.02);
      }

      this._tick = requestAnimationFrame(() => this._loop());
    }
  }

  global.EngineSynth = EngineSynth;
  global.ENGINE_PRESETS = ENGINES;
})(window);
