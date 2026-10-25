/**
 * Tesla V8 Sound – UI, GPS, optional DeviceMotion (original).
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const engine = new EngineSynth();

  let watchId = null;
  let speedKmh = 0;
  let lastSpeed = 0;
  let lastSpeedT = 0;
  let accelHint = null; // -1..1 from motion or derived
  let motionEnabled = false;
  let simMode = false;
  let simSpeed = 0;
  let lastPopNote = 0;

  const el = {
    start: $('#btn-start'),
    stop: $('#btn-stop'),
    vol: $('#volume'),
    volLabel: $('#volume-label'),
    engineSel: $('#engine-select'),
    speed: $('#speed-value'),
    rpm: $('#rpm-value'),
    gear: $('#gear-value'),
    status: $('#status-line'),
    gps: $('#gps-status'),
    motion: $('#motion-status'),
    up: $('#gear-up'),
    down: $('#gear-down'),
    rev: $('#btn-rev'),
    sim: $('#btn-sim'),
    simSlower: $('#sim-slower'),
    simFaster: $('#sim-faster'),
    disclaimer: $('#disclaimer'),
  };

  function setStatus(msg) {
    if (el.status) el.status.textContent = msg;
  }

  function fillEngines() {
    engine.listEngines().forEach((e) => {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = e.nameDe;
      el.engineSel.appendChild(o);
    });
  }

  async function startEngine() {
    try {
      await engine.start();
      el.start.disabled = true;
      el.stop.disabled = false;
      el.rev.disabled = false;
      setStatus('Motor läuft – Lautstärke am Fahrzeug drehen.');
      startGps();
      tryMotion();
      loopUi();
    } catch (err) {
      setStatus('Audio blockiert – bitte einmal tippen und erneut starten.');
      console.error(err);
    }
  }

  function stopEngine() {
    engine.stop();
    el.start.disabled = false;
    el.stop.disabled = true;
    el.rev.disabled = true;
    setStatus('Gestoppt.');
  }

  function startGps() {
    if (!navigator.geolocation) {
      el.gps.textContent = 'GPS: nicht verfügbar';
      return;
    }
    if (watchId != null) return;
    el.gps.textContent = 'GPS: warte auf Freigabe…';
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const sp = (pos.coords.speed != null && pos.coords.speed >= 0)
          ? pos.coords.speed * 3.6
          : deriveSpeedFromPositions(pos);
        if (!simMode) {
          const now = performance.now();
          if (lastSpeedT && now - lastSpeedT > 80) {
            const dv = (sp - lastSpeed) / ((now - lastSpeedT) / 1000); // km/h per s
            // crude accel hint from GPS delta
            accelHint = Math.max(-1, Math.min(1, dv / 25));
          }
          lastSpeed = sp;
          lastSpeedT = now;
          speedKmh = sp;
          engine.updateFromTelemetry(speedKmh, accelHint);
        }
        el.gps.textContent =
          'GPS: aktiv (±' +
          Math.round(pos.coords.accuracy || 0) +
          ' m) · Latenz möglich';
      },
      (err) => {
        el.gps.textContent = 'GPS: ' + (err.message || 'verweigert') + ' – Simulation nutzen';
      },
      { enableHighAccuracy: true, maximumAge: 500, timeout: 10000 }
    );
  }

  let prevLat = null;
  let prevLon = null;
  let prevT = null;
  function deriveSpeedFromPositions(pos) {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const t = pos.timestamp;
    if (prevLat == null) {
      prevLat = lat;
      prevLon = lon;
      prevT = t;
      return speedKmh;
    }
    const dt = (t - prevT) / 1000;
    if (dt < 0.3) return speedKmh;
    const R = 6371000;
    const dLat = ((lat - prevLat) * Math.PI) / 180;
    const dLon = ((lon - prevLon) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((prevLat * Math.PI) / 180) *
        Math.cos((lat * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    const d = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    prevLat = lat;
    prevLon = lon;
    prevT = t;
    return (d / dt) * 3.6;
  }

  function tryMotion() {
    el.motion.textContent =
      'Bewegungssensor: optional (Tesla-Browser oft ohne Sensoren – Handy-Tipp)';
    const handler = (ev) => {
      // Prefer accelerationIncludingGravity longitudinal guess
      const a = ev.acceleration;
      const ag = ev.accelerationIncludingGravity;
      let forward = 0;
      if (a && a.y != null) forward = a.y;
      else if (ag && ag.y != null) forward = ag.y; // rough
      // Normalize ~ ±4 m/s² → ±1
      accelHint = Math.max(-1, Math.min(1, forward / 4));
      motionEnabled = true;
      el.motion.textContent = 'Bewegungssensor: aktiv (Gas-Gefühl)';
      if (!simMode) engine.updateFromTelemetry(speedKmh, accelHint);
    };

    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      // iOS – only when user taps; we expose a button path via start
      DeviceMotionEvent.requestPermission()
        .then((state) => {
          if (state === 'granted') {
            window.addEventListener('devicemotion', handler, true);
          } else {
            el.motion.textContent = 'Bewegungssensor: verweigert – GPS reicht';
          }
        })
        .catch(() => {
          el.motion.textContent = 'Bewegungssensor: nicht verfügbar';
        });
    } else if (window.DeviceMotionEvent) {
      window.addEventListener('devicemotion', handler, true);
      // If no events arrive after a few seconds, keep tip visible
      setTimeout(() => {
        if (!motionEnabled) {
          el.motion.textContent =
            'Bewegungssensor: keine Daten (im Tesla normal) – gleiche Seite am Handy öffnen für Gas-Gefühl';
        }
      }, 4000);
    }
  }

  function loopUi() {
    if (!engine.running) return;
    if (simMode) {
      engine.updateFromTelemetry(simSpeed, accelHint != null ? accelHint : 0.35);
      speedKmh = simSpeed;
    }
    el.speed.textContent = Math.round(speedKmh);
    el.rpm.textContent = Math.round(engine.rpm);
    el.gear.textContent = String(engine.gear);
    requestAnimationFrame(loopUi);
  }

  // Controls
  el.start.addEventListener('click', startEngine);
  el.stop.addEventListener('click', stopEngine);
  el.vol.addEventListener('input', () => {
    const v = Number(el.vol.value) / 100;
    engine.setVolume(v);
    el.volLabel.textContent = Math.round(v * 100) + ' %';
  });
  el.engineSel.addEventListener('change', () => {
    engine.setEngine(el.engineSel.value);
    setStatus('Motor: ' + el.engineSel.selectedOptions[0].textContent);
  });
  el.up.addEventListener('click', () => engine.shiftUp());
  el.down.addEventListener('click', () => engine.shiftDown());

  // Hold to rev (parked)
  let revTimer = null;
  function revStart(ev) {
    ev.preventDefault();
    if (!engine.running) return;
    let amount = 0.2;
    revTimer = setInterval(() => {
      amount = Math.min(1, amount + 0.08);
      engine.setRev(amount);
      if (!simMode) {
        /* parked rev overrides telemetry briefly */
      }
    }, 50);
  }
  function revEnd(ev) {
    ev.preventDefault();
    clearInterval(revTimer);
    revTimer = null;
    if (engine.running) engine.setRev(0);
  }
  el.rev.addEventListener('pointerdown', revStart);
  el.rev.addEventListener('pointerup', revEnd);
  el.rev.addEventListener('pointerleave', revEnd);
  el.rev.addEventListener('pointercancel', revEnd);

  // Simulation helpers (for testing without driving)
  el.sim.addEventListener('click', () => {
    simMode = !simMode;
    el.sim.classList.toggle('active', simMode);
    el.sim.textContent = simMode ? 'Simulation AN' : 'Simulation';
    if (simMode) {
      simSpeed = Math.max(simSpeed, 30);
      setStatus('Simulationsmodus – Geschwindigkeit mit + / − ändern.');
    } else {
      setStatus('Simulation aus – GPS-Geschwindigkeit aktiv.');
    }
  });
  el.simFaster.addEventListener('click', () => {
    simMode = true;
    el.sim.classList.add('active');
    el.sim.textContent = 'Simulation AN';
    simSpeed = Math.min(250, simSpeed + 10);
  });
  el.simSlower.addEventListener('click', () => {
    simMode = true;
    el.sim.classList.add('active');
    el.sim.textContent = 'Simulation AN';
    simSpeed = Math.max(0, simSpeed - 10);
  });

  // Keyboard (Tesla scroll wheel / keyboard may send keys)
  window.addEventListener('keydown', (ev) => {
    if (ev.repeat) return;
    switch (ev.key) {
      case 'ArrowUp':
      case '+':
      case '=':
        engine.shiftUp();
        break;
      case 'ArrowDown':
      case '-':
      case '_':
        engine.shiftDown();
        break;
      case ' ':
        ev.preventDefault();
        if (engine.running) engine.setRev(0.85);
        break;
      case 's':
      case 'S':
        if (engine.running) stopEngine();
        else startEngine();
        break;
    }
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.key === ' ') engine.setRev(0);
  });

  // Service worker (optional offline)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  fillEngines();
  engine.setVolume(Number(el.vol.value) / 100);
  setStatus('Bereit – „Start“ tippen (Browser braucht eine Nutzeraktion für Audio).');
})();
