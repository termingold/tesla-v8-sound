/**
 * Pulse-driven V8 synthesizer (original).
 * NO continuous jet/whoosh noise — combustion impulse train is the voice.
 * Inspired by publicly described TesRev behaviour (pulses + gearbox), not their code/assets.
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
      // Cross-plane bank unevenness → idle lope (not a turbine)
      cylWeights: [1.0, 0.45, 0.95, 0.4, 1.05, 0.42, 0.9, 0.48],
      fireFrac: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875],
      toneBright: 0.35,
      rumble: 1.0,
      crackle: 0.85,
      pulseDecay: 0.0018, // per-sample-ish scale (tuned in processor)
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
      toneBright: 0.7,
      rumble: 0.35,
      crackle: 0.7,
      pulseDecay: 0.0022,
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
      pulseDecay: 0.002,
    },
  };

  const GEAR_RATIOS = [0, 3.6, 2.25, 1.55, 1.18, 0.92, 0.74, 0.62];
  const FINAL_DRIVE = 3.73;
  const WHEEL_RADIUS = 0.35;

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
      this.load = 0.12;
      this.volume = 0.65;
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
      this._crackleUntil = 0;

      // Shared with ScriptProcessor (audio thread reads these)
      this._shared = {
        rpm: 700,
        load: 0.12,
        cylWeights: ENGINES['v8-cross'].cylWeights.slice(),
        fireFrac: ENGINES['v8-cross'].fireFrac.slice(),
        cylinders: 8,
        toneBright: 0.35,
        rumble: 1,
        pulseDecay: 0.0018,
        crackleBurst: 0,
      };
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

    _syncShared() {
      const e = this.engine;
      const s = this._shared;
      s.rpm = this.rpm;
      s.load = this.load;
      s.cylWeights = e.cylWeights;
      s.fireFrac = e.fireFrac;
      s.cylinders = e.cylinders;
      s.toneBright = e.toneBright;
      s.rumble = e.rumble;
      s.pulseDecay = e.pulseDecay;
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
      this._syncShared();
      this._lastT = this.ctx.currentTime;
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
        this._outGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.04);
      }
    }

    updateFromTelemetry(speedKmh, accelHint) {
      if (this.demoActive) return;
      const e = this.engine;
      const speed = Math.max(0, speedKmh || 0);
      const now = performance.now();
      let load;
      if (typeof accelHint === 'number' && !Number.isNaN(accelHint)) {
        load = clamp(0.1 + accelHint * 0.95, 0.02, 1);
      } else {
        load = speed < 2 ? 0.14 : clamp(0.25 + speed / 220, 0.2, 0.7);
      }
      if (!this.manualShift || now > this.shiftHoldUntil) {
        this.manualShift = false;
        this._autoGear(speed, load, e);
      }
      const wheelRpm =
        speed > 0.5 ? ((speed / 3.6) / (2 * Math.PI * WHEEL_RADIUS)) * 60 : 0;
      const ratio = GEAR_RATIOS[this.gear] || 1.5;
      let rpm = wheelRpm * ratio * FINAL_DRIVE;
      if (speed < 1.2) rpm = e.idleRpm * (1 + load * 0.15);
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
      this._shared.crackleBurst = 0.9;
      setTimeout(() => {
        this._shifting = false;
      }, 200);
    }

    /** Demo: long idle lope first (diagnostic vs airplane), then drive. */
    playDemoDrive() {
      this.stopDemo();
      if (!this.running) return;
      this.demoActive = true;
      const e = this.engine;
      const steps = [
        // ~5 s clear idle lope — must sound like V8, not jet
        { t: 0, rpm: e.idleRpm, load: 0.15, gear: 1, speed: 0 },
        { t: 5.0, rpm: e.idleRpm * 1.02, load: 0.16, gear: 1, speed: 0 },
        { t: 5.5, rpm: e.redline * 0.4, load: 0.85, gear: 1, speed: 0 },
        { t: 6.0, rpm: e.idleRpm, load: 0.12, gear: 1, speed: 0, crackle: true },
        { t: 6.8, rpm: e.redline * 0.55, load: 1.0, gear: 1, speed: 30 },
        { t: 8.0, rpm: e.redline * 0.92, load: 1.0, gear: 1, speed: 55 },
        { t: 8.2, rpm: e.redline * 0.6, load: 0.95, gear: 2, speed: 60 },
        { t: 9.5, rpm: e.redline * 0.9, load: 1.0, gear: 2, speed: 95 },
        { t: 9.7, rpm: e.redline * 0.58, load: 0.95, gear: 3, speed: 100 },
        { t: 11.0, rpm: e.redline * 0.85, load: 0.9, gear: 3, speed: 130 },
        { t: 11.5, rpm: e.redline * 0.5, load: 0.05, gear: 3, speed: 125, crackle: true },
        { t: 12.8, rpm: e.redline * 0.45, load: 0.06, gear: 2, speed: 80 },
        { t: 14.0, rpm: e.idleRpm * 2.2, load: 0.1, gear: 2, speed: 40 },
        { t: 14.6, rpm: e.redline * 0.88, load: 1.0, gear: 2, speed: 70 },
        { t: 16.0, rpm: e.redline * 0.7, load: 0.7, gear: 3, speed: 110 },
        { t: 17.5, rpm: e.redline * 0.35, load: 0.05, gear: 3, speed: 60, crackle: true },
        { t: 19.0, rpm: e.idleRpm, load: 0.14, gear: 1, speed: 0 },
        { t: 21.0, rpm: e.idleRpm, load: 0.14, gear: 1, speed: 0, end: true },
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
          this._shared.crackleBurst = 1;
        }
        if (a.end || elapsed > 22) {
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
      this._teardown();
      this._syncShared();
      const shared = this._shared;

      this._outGain = ctx.createGain();
      this._outGain.gain.value = this.volume;

      // Mild tone shaping only — no hiss generator in the path
      this._lp = ctx.createBiquadFilter();
      this._lp.type = 'lowpass';
      this._lp.frequency.value = 2800;
      this._lp.Q.value = 0.7;

      this._hp = ctx.createBiquadFilter();
      this._hp.type = 'highpass';
      this._hp.frequency.value = 40;
      this._hp.Q.value = 0.5;

      this._thump = ctx.createBiquadFilter();
      this._thump.type = 'peaking';
      this._thump.frequency.value = 90;
      this._thump.Q.value = 0.9;
      this._thump.gain.value = 6;

      this._bark = ctx.createBiquadFilter();
      this._bark.type = 'peaking';
      this._bark.frequency.value = 480;
      this._bark.Q.value = 1.1;
      this._bark.gain.value = 2;

      // Core: ScriptProcessor impulse train (pulse-driven, not noise-drone)
      const bufferSize = 1024;
      const proc =
        ctx.createScriptProcessor && ctx.createScriptProcessor(bufferSize, 1, 1);
      if (!proc) {
        console.error('ScriptProcessor unavailable');
        return;
      }

      // Processor state (closed over)
      let cyclePhase = 0; // 0..1 over one crank revolution group (fire cycle)
      let env = 0;
      let tonePhase = 0;
      let subPhase = 0;
      let lastFireIdx = -1;
      let crackleEnv = 0;
      // Tiny noise only for crackle pops (gated), never continuous exhaust whoosh
      let noiseState = 0;

      proc.onaudioprocess = function (ev) {
        const out = ev.outputBuffer.getChannelData(0);
        const sr = ctx.sampleRate;
        const rpm = Math.max(400, shared.rpm || 700);
        const load = shared.load || 0.1;
        const cyl = shared.cylinders || 8;
        const weights = shared.cylWeights;
        const fracs = shared.fireFrac;
        const bright = shared.toneBright || 0.35;
        const rumble = shared.rumble || 1;
        // Firing rate: 4-stroke → cylinders/2 fires per revolution
        const revPerSec = rpm / 60;
        const firePerSec = revPerSec * (cyl / 2);
        // Advance cycle phase by revolutions (one full set of cyl fires = 2 revs for 4-stroke,
        // but we map fireFrac over one revolution of the firing order spanning 2 crank revs).
        // Simpler: treat fireFrac as positions within one firing cycle of length 1,
        // advanced at firePerSec / cyl (one full cycle of all cylinders).
        const cyclePerSec = firePerSec / cyl; // complete all-cylinder cycle rate
        // Short pulses at idle (distinct chugs); slightly longer under load (bark body)
        const envDecayPerSec = 55 - load * 22; // ~55/s idle → ~33/s WOT
        const decayCoef = Math.exp(-envDecayPerSec / sr);

        if (shared.crackleBurst > 0) {
          crackleEnv = Math.max(crackleEnv, 0.7 * shared.crackleBurst);
          shared.crackleBurst *= 0.85;
          if (shared.crackleBurst < 0.05) shared.crackleBurst = 0;
        }

        for (let i = 0; i < out.length; i++) {
          const prev = cyclePhase;
          cyclePhase += cyclePerSec / sr;
          if (cyclePhase >= 1) cyclePhase -= 1;

          // Detect cylinder firings crossed in this sample
          for (let c = 0; c < cyl; c++) {
            const f = fracs[c] || c / cyl;
            // crossed fractional fire point
            const crossed =
              (prev < f && cyclePhase >= f) ||
              (prev > cyclePhase && (f >= prev || f < cyclePhase));
            if (crossed) {
              const w = weights[c] || 1;
              // Idle: strong uneven pulses. Load: louder but still pulsed.
              const hit = w * (0.45 + load * 0.85) * (0.75 + rumble * 0.35);
              env = Math.max(env, hit);
              lastFireIdx = c;
            }
          }

          env *= decayCoef;

          // Pulse-driven tone (not noise): short harmonic burst on each fire
          const fund = firePerSec; // Hz of successive fires
          tonePhase += (fund * 0.5 * Math.PI * 2) / sr; // half-order body
          subPhase += (revPerSec * Math.PI * 2) / sr;

          // Soft clip pulse shape
          const pulse = env * env; // emphasize attack a bit less harsh than raw env
          const fundTone = Math.sin(tonePhase);
          const h2 = Math.sin(tonePhase * 2) * (0.35 + load * 0.4);
          const h3 = Math.sin(tonePhase * 3) * bright * (0.15 + load * 0.35);
          const sub = Math.sin(subPhase) * rumble * (0.25 + (1 - Math.min(1, rpm / 4000)) * 0.35);

          // Very sparse crackle: gated click, not continuous hiss
          let crack = 0;
          if (crackleEnv > 0.01) {
            noiseState = (noiseState * 1103515245 + 12345) & 0x7fffffff;
            const n = (noiseState / 0x7fffffff) * 2 - 1;
            crack = n * crackleEnv * crackleEnv * 0.55;
            crackleEnv *= Math.exp(-25 / sr * 60);
          }

          // Coast: quieter, darker (multiply highs by load)
          const coast = 0.35 + load * 0.75;
          let sample =
            (pulse * (fundTone * 0.7 + h2 + h3) + pulse * sub * 0.5) * coast + crack;

          // Soft limit
          if (sample > 1) sample = 1;
          if (sample < -1) sample = -1;
          out[i] = sample * 0.55;
        }
      };

      this._proc = proc;
      this._proc = proc;
      // Dummy input keeps ScriptProcessor alive in some Chromium builds
      this._dummy = ctx.createGain();
      this._dummy.gain.value = 0;
      const keepAlive = ctx.createOscillator();
      keepAlive.frequency.value = 1;
      keepAlive.connect(this._dummy);
      this._dummy.connect(proc);
      keepAlive.start();
      this._keepAlive = keepAlive;

      proc.connect(this._hp);
      this._hp.connect(this._thump);
      this._thump.connect(this._bark);
      this._bark.connect(this._lp);
      this._lp.connect(this._outGain);
      this._outGain.connect(ctx.destination);
    }

    _teardown() {
      try {
        if (this._proc) {
          this._proc.onaudioprocess = null;
          this._proc.disconnect();
        }
        if (this._outGain) this._outGain.disconnect();
        if (this._dummy) this._dummy.disconnect();
        if (this._keepAlive) {
          try { this._keepAlive.stop(); } catch (e) {}
          try { this._keepAlive.disconnect(); } catch (e) {}
        }
      } catch (_) {}
      this._proc = null;
    }

    _loop() {
      if (!this.running || !this.ctx) return;
      const t = this.ctx.currentTime;
      const dt = Math.min(0.05, Math.max(0.008, t - (this._lastT || t - 0.016)));
      this._lastT = t;
      const e = this.engine;

      const lag = this.load > 0.5 ? 0.05 : 0.12;
      this.rpm += (this.targetRpm - this.rpm) * Math.min(1, dt / lag);
      this.rpm = clamp(this.rpm, e.idleRpm * 0.85, e.redline * 1.05);

      const dLoad = this._prevLoad - this.load;
      if (dLoad > 0.25 && this.rpm > e.idleRpm * 1.5) {
        this._shared.crackleBurst = Math.min(1.2, dLoad * 2.2 * e.crackle);
      }
      this._prevLoad = this.load;
      this._syncShared();

      const rpmN = clamp((this.rpm - e.idleRpm) / (e.redline - e.idleRpm), 0, 1);
      // Tone stack follows load — darker on coast (engine braking), bark on throttle
      if (this._lp) {
        const cut = 900 + rpmN * 2200 + this.load * 1400 - (this.load < 0.2 ? 500 : 0);
        this._lp.frequency.setTargetAtTime(clamp(cut, 500, 6000), t, 0.05);
      }
      if (this._bark) {
        this._bark.gain.setTargetAtTime(1 + this.load * 7 * (0.4 + rpmN), t, 0.06);
        this._bark.frequency.setTargetAtTime(380 + rpmN * 350, t, 0.08);
      }
      if (this._thump) {
        this._thump.gain.setTargetAtTime(4 + e.rumble * 4 * (1 - rpmN * 0.6), t, 0.08);
      }

      this._tick = requestAnimationFrame(() => this._loop());
    }
  }

  global.EngineSynth = EngineSynth;
  global.ENGINE_PRESETS = ENGINES;
})(window);
