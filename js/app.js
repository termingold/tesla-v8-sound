/**
 * Tesla V8 Sound – UI, GPS, optional DeviceMotion, Demo-Fahrt (original).
 * v7: robuste Button-Zustände, UI-Loop überlebt Mode-/Motor-Wechsel.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const engine = new EngineSynth();
  // Test-/Debug-Hook
  window.__teslaV8 = { engine };

  let watchId = null;
  let speedKmh = 0;
  let lastSpeed = 0;
  let lastSpeedT = 0;
  let accelHint = null;
  let motionEnabled = false;
  let simMode = false;
  let simSpeed = 0;
  let uiRunning = false;
  let starting = false;
  let revHolding = false;
  let motionHooked = false;

  const el = {
    start: $('#btn-start'),
    stop: $('#btn-stop'),
    vol: $('#volume'),
    volLabel: $('#volume-label'),
    engineSel: $('#engine-select'),
    soundMode: $('#sound-mode'),
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

  function syncTransportButtons() {
    const on = !!engine.running;
    if (el.start) el.start.disabled = on || starting;
    if (el.stop) el.stop.disabled = !on;
    if (el.rev) el.rev.disabled = !on;
    if (el.demo) {
      el.demo.disabled = !on;
      el.demo.textContent = engine.demoActive
        ? 'Demo stoppen'
        : 'Demo-Fahrt (erst Idle-Lope)';
      el.demo.classList.toggle('active', !!engine.demoActive);
    }
    if (el.up) el.up.disabled = !on;
    if (el.down) el.down.disabled = !on;
  }

  function ensureUiLoop() {
    if (uiRunning) return;
    uiRunning = true;
    loopUi();
  }

  function fillEngines() {
    if (!el.engineSel) return;
    el.engineSel.innerHTML = '';
    engine.listEngines().forEach((e) => {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = e.nameDe;
      el.engineSel.appendChild(o);
    });
    el.engineSel.value = engine.engineId;
  }

  async function startEngine() {
    if (starting || engine.running) {
      syncTransportButtons();
      return;
    }
    starting = true;
    syncTransportButtons();
    try {
      setStatus('Starte Audio…');
      await engine.start();
      const st = engine.audioState || (engine.ctx && engine.ctx.state) || '?';
      setStatus(
        'Motor läuft (Audio: ' +
          st +
          ', ' +
          (engine.soundMode === 'sample' ? 'Sample' : 'Synth') +
          ') – Idle hörbar. Demo oder Simulation testen.'
      );
      startGps();
      tryMotion();
      ensureUiLoop();
    } catch (err) {
      setStatus(
        'Kein Sound: ' +
          (engine.lastError || err.message || err) +
          ' – erneut Start tippen (Autoplay-Sperre).'
      );
      console.error(err);
    } finally {
      starting = false;
      syncTransportButtons();
    }
  }

  function stopEngine() {
    revHolding = false;
    clearInterval(revTimer);
    revTimer = null;
    engine.stop();
    syncTransportButtons();
    setStatus('Gestoppt.');
    paintGauges();
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
        if (!simMode && !engine.demoActive && !revHolding) {
          const now = performance.now();
          if (lastSpeedT && now - lastSpeedT > 80) {
            const dv = (sp - lastSpeed) / ((now - lastSpeedT) / 1000);
            accelHint = Math.max(-1, Math.min(1, dv / 22));
          }
          lastSpeed = sp;
          lastSpeedT = now;
          speedKmh = sp;
          if (engine.running) engine.updateFromTelemetry(speedKmh, accelHint);
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

  let prevLat = null,
    prevLon = null,
    prevT = null;
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
    if (motionHooked) return;
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
      if (!simMode && !engine.demoActive && !revHolding && engine.running) {
        engine.updateFromTelemetry(speedKmh, accelHint);
      }
    };

    if (
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function'
    ) {
      DeviceMotionEvent.requestPermission()
        .then((state) => {
          if (state === 'granted') {
            window.addEventListener('devicemotion', handler, true);
            motionHooked = true;
          } else el.motion.textContent = 'Bewegungssensor: verweigert – GPS reicht';
        })
        .catch(() => {
          el.motion.textContent = 'Bewegungssensor: nicht verfügbar';
        });
    } else if (window.DeviceMotionEvent) {
      window.addEventListener('devicemotion', handler, true);
      motionHooked = true;
      setTimeout(() => {
        if (!motionEnabled) {
          el.motion.textContent =
            'Bewegungssensor: keine Daten (im Tesla normal) – Handy für Gas-Gefühl';
        }
      }, 4000);
    }
  }

  function paintGauges() {
    if (engine.demoActive) {
      speedKmh = engine.demoSpeed;
    } else if (simMode) {
      speedKmh = simSpeed;
    }
    if (el.speed) el.speed.textContent = String(Math.round(speedKmh));
    if (el.rpm) el.rpm.textContent = String(Math.round(engine.rpm || 0));
    if (el.gear) el.gear.textContent = String(engine.gear || 1);
    if (el.audioDebug) {
      el.audioDebug.textContent =
        'Audio: ' +
        (engine.audioState || (engine.running ? '?' : 'gestoppt')) +
        ' · ' +
        (engine.soundMode === 'sample' ? 'Sample' : 'Synth') +
        ' · Vol ' +
        Math.round(engine.volume * 100) +
        '% · RPM ' +
        Math.round(engine.rpm || 0) +
        (engine.demoActive ? ' · DEMO' : '');
    }
    syncTransportButtons();
  }

  function loopUi() {
    if (!engine.running) {
      uiRunning = false;
      paintGauges();
      return;
    }
    if (engine.demoActive) {
      speedKmh = engine.demoSpeed;
    } else if (simMode && !revHolding) {
      const hint = accelHint != null ? accelHint : 0.55;
      engine.updateFromTelemetry(simSpeed, hint);
      speedKmh = simSpeed;
    }
    paintGauges();
    requestAnimationFrame(loopUi);
  }

  async function afterEngineRebuild(label) {
    ensureUiLoop();
    syncTransportButtons();
    paintGauges();
    if (label) setStatus(label);
  }

  el.start.addEventListener('click', (ev) => {
    ev.preventDefault();
    startEngine();
  });
  el.stop.addEventListener('click', (ev) => {
    ev.preventDefault();
    stopEngine();
  });

  el.vol.addEventListener('input', () => {
    const v = Number(el.vol.value) / 100;
    engine.setVolume(v);
    el.volLabel.textContent = Math.round(v * 100) + ' %';
  });

  el.engineSel.addEventListener('change', async () => {
    const id = el.engineSel.value;
    const name = el.engineSel.selectedOptions[0]
      ? el.engineSel.selectedOptions[0].textContent
      : id;
    try {
      setStatus('Wechsle Motor: ' + name + '…');
      await engine.setEngine(id);
      await afterEngineRebuild('Motor: ' + name);
    } catch (err) {
      setStatus('Motorwechsel fehlgeschlagen: ' + (err.message || err));
      console.error(err);
      syncTransportButtons();
    }
  });

  if (el.soundMode) {
    el.soundMode.addEventListener('change', async () => {
      const mode = el.soundMode.value;
      try {
        if (mode === 'sample') setStatus('Lade Freesound-Samples (CC-BY/CC0)…');
        await engine.setSoundMode(mode);
        await afterEngineRebuild(
          mode === 'sample'
            ? 'Sample-Modus: Lumamorph Idle (CC-BY) + Henaway Rev (CC0).'
            : 'Synthese-Modus (Original, keine Fremd-Samples).'
        );
      } catch (err) {
        setStatus(
          'Sample-Modus fehlgeschlagen: ' +
            (err.message || err) +
            ' – bleibe bei Synthese.'
        );
        console.error(err);
        el.soundMode.value = 'synth';
        try {
          await engine.setSoundMode('synth');
        } catch (_) {}
        await afterEngineRebuild(null);
      }
    });
  }

  el.up.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (!engine.running) return;
    engine.shiftUp();
    paintGauges();
  });
  el.down.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (!engine.running) return;
    engine.shiftDown();
    paintGauges();
  });

  if (el.demo) {
    el.demo.addEventListener('click', async (ev) => {
      ev.preventDefault();
      if (!engine.running) await startEngine();
      if (!engine.running) return;
      if (engine.demoActive) {
        engine.stopDemo();
        setStatus('Demo gestoppt – Idle.');
        syncTransportButtons();
        return;
      }
      simMode = false;
      el.sim.classList.remove('active');
      el.sim.textContent = 'Simulation';
      engine.playDemoDrive();
      setStatus(
        'Demo: zuerst ~5 s Idle-Lope – dann Launch/Crackles. Erneut tippen = Stop.'
      );
      ensureUiLoop();
      syncTransportButtons();
    });
  }

  let revTimer = null;
  function revStart(ev) {
    if (ev && ev.cancelable) ev.preventDefault();
    if (!engine.running || engine.demoActive) return;
    revHolding = true;
    let amount = 0.25;
    engine.setRev(amount);
    clearInterval(revTimer);
    revTimer = setInterval(() => {
      amount = Math.min(1, amount + 0.08);
      engine.setRev(amount);
    }, 50);
  }
  function revEnd(ev) {
    if (ev && ev.cancelable) ev.preventDefault();
    clearInterval(revTimer);
    revTimer = null;
    if (!revHolding) return;
    revHolding = false;
    if (engine.running && !engine.demoActive) {
      engine.setRev(0);
    }
  }
  // Pointer + Touch + Mouse: Tesla-Browser liefert oft nur Touch/Click
  ['pointerdown', 'touchstart', 'mousedown'].forEach((type) => {
    el.rev.addEventListener(type, revStart, { passive: false });
  });
  ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach(
    (type) => {
      el.rev.addEventListener(type, revEnd, { passive: false });
    }
  );
  // pointerleave can fire spuriously on some touch stacks — only end if not primary touch
  el.rev.addEventListener('pointerleave', (ev) => {
    if (ev.pointerType === 'mouse') revEnd(ev);
  });

  function setSim(on) {
    if (on && engine.demoActive) engine.stopDemo();
    simMode = !!on;
    el.sim.classList.toggle('active', simMode);
    el.sim.textContent = simMode ? 'Simulation AN' : 'Simulation';
    if (simMode) {
      // Auto-Gang wieder erlauben (manuelle Schaltung nicht blockieren)
      engine.manualShift = false;
      engine.shiftHoldUntil = 0;
      speedKmh = simSpeed;
      if (engine.running && !revHolding) {
        engine.updateFromTelemetry(simSpeed, accelHint != null ? accelHint : 0.55);
      }
      setStatus('Simulationsmodus – Geschwindigkeit mit + / − ändern.');
    } else {
      setStatus('Simulation aus – GPS-Geschwindigkeit aktiv.');
    }
    paintGauges();
  }

  el.sim.addEventListener('click', (ev) => {
    ev.preventDefault();
    setSim(!simMode);
  });
  el.simFaster.addEventListener('click', (ev) => {
    ev.preventDefault();
    simSpeed = Math.min(250, simSpeed + 10);
    accelHint = 0.8;
    setSim(true);
  });
  el.simSlower.addEventListener('click', (ev) => {
    ev.preventDefault();
    simSpeed = Math.max(0, simSpeed - 10);
    accelHint = -0.5;
    setSim(true);
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.repeat) return;
    const tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    switch (ev.key) {
      case 'ArrowUp':
      case '+':
      case '=':
        if (engine.running) engine.shiftUp();
        break;
      case 'ArrowDown':
      case '-':
      case '_':
        if (engine.running) engine.shiftDown();
        break;
      case ' ':
        ev.preventDefault();
        if (engine.running && !engine.demoActive) {
          revHolding = true;
          engine.setRev(0.9);
        }
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
    if (ev.key === ' ' && engine.running && !engine.demoActive) {
      revHolding = false;
      engine.setRev(0);
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js?v=7').catch(() => {});
  }

  fillEngines();
  if (el.soundMode) el.soundMode.value = engine.soundMode || 'synth';
  engine.setVolume(Number(el.vol.value) / 100);
  syncTransportButtons();
  setStatus(
    'Bereit v7 – alle Buttons nach Start nutzbar. Hard-Reload falls alt gecacht.'
  );
})();
