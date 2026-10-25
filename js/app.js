/**
 * Tesla V8 Sound – UI, GPS, optional DeviceMotion, Demo-Fahrt (original).
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const engine = new EngineSynth();

  let watchId = null;
  let speedKmh = 0;
  let lastSpeed = 0;
  let lastSpeedT = 0;
  let accelHint = null;
  let motionEnabled = false;
  let simMode = false;
  let simSpeed = 0;
  let uiRunning = false;

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
    demo: $('#btn-demo'),
    audioDebug: $('#audio-debug'),
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
      setStatus('Starte Audio…');
      await engine.start();
      el.start.disabled = true;
      el.stop.disabled = false;
      el.rev.disabled = false;
      if (el.demo) el.demo.disabled = false;
      const st = engine.audioState || (engine.ctx && engine.ctx.state) || '?';
      setStatus(
        'Motor läuft (Audio: ' +
          st +
          ') – Idle sollte jetzt hörbar sein. Lautstärke am Auto hoch. Demo-Fahrt testen.'
      );
      startGps();
      tryMotion();
      if (!uiRunning) {
        uiRunning = true;
        loopUi();
      }
    } catch (err) {
      setStatus(
        'Kein Sound: ' +
          (engine.lastError || err.message || err) +
          ' – erneut Start tippen (Autoplay-Sperre).'
      );
      console.error(err);
    }
  }

  function stopEngine() {
    engine.stop();
    el.start.disabled = false;
    el.stop.disabled = true;
    el.rev.disabled = true;
    if (el.demo) el.demo.disabled = true;
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
        const sp =
          pos.coords.speed != null && pos.coords.speed >= 0
            ? pos.coords.speed * 3.6
            : deriveSpeedFromPositions(pos);
        if (!simMode && !engine.demoActive) {
          const now = performance.now();
          if (lastSpeedT && now - lastSpeedT > 80) {
            const dv = (sp - lastSpeed) / ((now - lastSpeedT) / 1000);
            accelHint = Math.max(-1, Math.min(1, dv / 22));
          }
          lastSpeed = sp;
          lastSpeedT = now;
          speedKmh = sp;
          engine.updateFromTelemetry(speedKmh, accelHint);
        }
        el.gps.textContent =
          'GPS: aktiv (±' + Math.round(pos.coords.accuracy || 0) + ' m) · etwas Latenz möglich';
      },
      (err) => {
        el.gps.textContent = 'GPS: ' + (err.message || 'verweigert') + ' – Simulation/Demo nutzen';
      },
      { enableHighAccuracy: true, maximumAge: 400, timeout: 10000 }
    );
  }

  let prevLat = null, prevLon = null, prevT = null;
  function deriveSpeedFromPositions(pos) {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const t = pos.timestamp;
    if (prevLat == null) {
      prevLat = lat; prevLon = lon; prevT = t;
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
    prevLat = lat; prevLon = lon; prevT = t;
    return (d / dt) * 3.6;
  }

  function tryMotion() {
    el.motion.textContent =
      'Bewegungssensor: optional (Tesla-Browser oft ohne – gleiche Seite am Handy öffnen)';
    const handler = (ev) => {
      const a = ev.acceleration;
      const ag = ev.accelerationIncludingGravity;
      let forward = 0;
      if (a && a.y != null) forward = a.y;
      else if (ag && ag.y != null) forward = ag.y;
      accelHint = Math.max(-1, Math.min(1, forward / 4));
      motionEnabled = true;
      el.motion.textContent = 'Bewegungssensor: aktiv (Gas-/Schub-Gefühl)';
      if (!simMode && !engine.demoActive) {
        engine.updateFromTelemetry(speedKmh, accelHint);
      }
    };

    if (
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function'
    ) {
      DeviceMotionEvent.requestPermission()
        .then((state) => {
          if (state === 'granted') window.addEventListener('devicemotion', handler, true);
          else el.motion.textContent = 'Bewegungssensor: verweigert – GPS reicht';
        })
        .catch(() => {
          el.motion.textContent = 'Bewegungssensor: nicht verfügbar';
        });
    } else if (window.DeviceMotionEvent) {
      window.addEventListener('devicemotion', handler, true);
      setTimeout(() => {
        if (!motionEnabled) {
          el.motion.textContent =
            'Bewegungssensor: keine Daten (im Tesla normal) – Handy für Gas-Gefühl';
        }
      }, 4000);
    }
  }

  function loopUi() {
    if (!engine.running) {
      uiRunning = false;
      return;
    }
    if (engine.demoActive) {
      speedKmh = engine.demoSpeed;
    } else if (simMode) {
      // Simulate throttle from rising/falling sim speed
      const hint = accelHint != null ? accelHint : 0.55;
      engine.updateFromTelemetry(simSpeed, hint);
      speedKmh = simSpeed;
    }
    el.speed.textContent = Math.round(speedKmh);
    el.rpm.textContent = Math.round(engine.rpm);
    el.gear.textContent = String(engine.gear);
    if (el.audioDebug) {
      el.audioDebug.textContent =
        'Audio: ' +
        (engine.audioState || '?') +
        ' · Vol ' +
        Math.round(engine.volume * 100) +
        '% · RPM ' +
        Math.round(engine.rpm);
    }
    requestAnimationFrame(loopUi);
  }

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

  if (el.demo) {
    el.demo.addEventListener('click', async () => {
      if (!engine.running) await startEngine();
      simMode = false;
      el.sim.classList.remove('active');
      el.sim.textContent = 'Simulation';
      engine.playDemoDrive();
      setStatus('Demo: zuerst ~5 s Idle-Lope (V8-Chugs) – kein Flugzeug. Dann Launch/Crackles.');
    });
  }

  let revTimer = null;
  function revStart(ev) {
    ev.preventDefault();
    if (!engine.running || engine.demoActive) return;
    let amount = 0.2;
    revTimer = setInterval(() => {
      amount = Math.min(1, amount + 0.08);
      engine.setRev(amount);
    }, 50);
  }
  function revEnd(ev) {
    ev.preventDefault();
    clearInterval(revTimer);
    revTimer = null;
    if (engine.running && !engine.demoActive) {
      // overrun crackle on release
      const was = engine.load;
      engine.setRev(0);
      if (was > 0.4) {
        /* synthesizer detects load drop */
      }
    }
  }
  el.rev.addEventListener('pointerdown', revStart);
  el.rev.addEventListener('pointerup', revEnd);
  el.rev.addEventListener('pointerleave', revEnd);
  el.rev.addEventListener('pointercancel', revEnd);

  el.sim.addEventListener('click', () => {
    if (engine.demoActive) engine.stopDemo();
    simMode = !simMode;
    el.sim.classList.toggle('active', simMode);
    el.sim.textContent = simMode ? 'Simulation AN' : 'Simulation';
    setStatus(
      simMode
        ? 'Simulationsmodus – Geschwindigkeit mit + / − ändern.'
        : 'Simulation aus – GPS-Geschwindigkeit aktiv.'
    );
  });
  el.simFaster.addEventListener('click', () => {
    if (engine.demoActive) engine.stopDemo();
    simMode = true;
    el.sim.classList.add('active');
    el.sim.textContent = 'Simulation AN';
    simSpeed = Math.min(250, simSpeed + 10);
    accelHint = 0.8;
  });
  el.simSlower.addEventListener('click', () => {
    if (engine.demoActive) engine.stopDemo();
    simMode = true;
    el.sim.classList.add('active');
    el.sim.textContent = 'Simulation AN';
    simSpeed = Math.max(0, simSpeed - 10);
    accelHint = -0.5;
  });

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
        if (engine.running && !engine.demoActive) engine.setRev(0.9);
        break;
      case 's':
      case 'S':
        if (engine.running) stopEngine();
        else startEngine();
        break;
      case 'd':
      case 'D':
        if (el.demo) el.demo.click();
        break;
    }
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.key === ' ' && engine.running && !engine.demoActive) engine.setRev(0);
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  fillEngines();
  engine.setVolume(Number(el.vol.value) / 100);
  if (el.demo) el.demo.disabled = true;
  setStatus('Bereit v5 – einmal Hard-Reload, dann START tippen. Idle sofort hörbar (kurzer Klick + Lope).');
})();
