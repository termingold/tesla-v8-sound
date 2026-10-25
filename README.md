## v8 User-V8-Sample + Schalt-Drehzahl

Primärer Klang: **vom Nutzer gelieferter V8-Referenzclip** (`samples/user_v8_drive.ogg`).
Sample-Modus ist Standard; Synthese bleibt Fallback.

Aus der Aufnahme abgeleitet:
- Idle ≈ **780 U/min**
- Hochschalten typisch bei ≈ **3500–3800 U/min**
- Deutlicher Drehzahlabfall beim Hochschalten (z. B. ~3600 → ~1950)
- Pitch-Basis (`_sampleBaseRpm`) ≈ **2100**

Physik: Gangwechsel ändern RPM/Pitch hörbar (Freeze kurz beim Schalten);
Simulation löst manuellen Schalt-Hold, damit Drehzahl nicht am Idle klebt.
Service-Worker-Cache **v8** — Hard-Reload nach Deploy.

## v7 Buttons-Fix

Systematischer UI-Test (Playwright): Start/Stop, Demo-Toggle, Simulation ±, Gänge, Lautstärke, Motortyp, Klangquelle Sample/Synth, Gas-Halten.
Fixes: UI-Loop starb nach Motor-/Sample-Wechsel; Sample blieb „Synth“ in der Anzeige; Demo ohne Stop; manuelle Gänge blockierten Simulation; Start-Lock; Touch/Pointer für Gas; SW-Cache v7.


## v5 Sound-Fix („kein Sound“)

v4 nutzte `ScriptProcessor` — in manchen Chromium/Tesla-Builds **stumm**.
v5: **BufferSource-Pulsschleife** + Oszillatoren, `audioContext.resume()` beim Start-Tipp,
kurzer Start-Klick, Audio-Status in der UI, Service-Worker **network-first** (Cache `v5`).


## Anti-Flugzeug-Fix (v4)

Feedback: „hört sich an wie ein Flugzeug“. Ursache: zu viel **Dauerrauschen** (Whoosh).
Jetzt: **pulsgetriebene** Verbrennungs-Impulse (ScriptProcessor-Impulszug), praktisch kein kontinuierliches Exhaust/Intake-Rauschen.
Demo beginnt mit ~5 s Idle-Lope zum Gegenprüfen.


## v6 Sample-Modus (optional)

Ab v8 ist **Sample V8 (User-Sound)** Standard; Synthese optional:
- Idle-Loop: [Lumamorph – Eight-cylinder engine idling](https://freesound.org/people/Lumamorph/sounds/636066/) (**CC BY 4.0**)
- Rev-One-Shot: [Henaway – Big Block V8 Rev](https://freesound.org/people/Henaway/sounds/127980/) (**CC0**)

Details: [`samples/ATTRIBUTION.txt`](samples/ATTRIBUTION.txt). In der UI unter **Klangquelle** umschalten.

### Free-Sample-Suche (Ergebnis)

| # | Name | Lizenz | URL | Inhalt | Qualität |
|---|------|--------|-----|--------|----------|
| 1 | Eight-cylinder engine idling (Lumamorph) | **CC BY 4.0** | https://freesound.org/people/Lumamorph/sounds/636066/ | Sauberer US-V8-Leerlauf, ~25 s Loop | **Beste Wahl** für Kabinen-Loop |
| 2 | Big Block V8 Rev (Henaway) | **CC0** | https://freesound.org/people/Henaway/sounds/127980/ | Kurzer Ford-460-Rev (~3,7 s) | Gut als One-Shot, kein Loop |
| 3 | Hot-Rod V8 start/drive (Ears68) | **CC0** | https://freesound.org/people/Ears68/sounds/146832/ | Start + Wegfahren + Festival-Ambience | Zu viel Ambiente für Kabine |
| 4 | Rough Idle + Burnout (Ears68) | **CC0** | https://freesound.org/people/Ears68/sounds/213976/ | Idle + Burnout + Publikum/PA | Feldaufnahme, nicht loopbar |
| 5 | Open Header V8 Parade (holderall) | **CC0** | https://freesound.org/people/holderall/sounds/432508/ | Idle/Rev mit Parade/Stimmen | CC0, aber unsauber für Loop |
| 6 | Generic Car / Racing loops (OGA) | CC0 bzw. **CC-BY-SA 4.0** | https://opengameart.org/content/racing-car-engine-sound-loops | Generische Loops | Zu generisch / SA problematisch |

**Empfehlung zum Einbetten:** Lumamorph (CC-BY mit Attribution) + Henaway (CC0) — so umgesetzt in v6.

Pixabay/Mixkit: oft „frei nutzbar“, aber **kein klares CC0**; für öffentliches GitHub Pages bewusst nicht eingebettet. **Kein YouTube-Rip.** CC-BY-NC und CC-BY-SA vermieden.


## Öffentliche URL

https://termingold.github.io/tesla-v8-sound/

# Tesla V8 Sound (kostenlos)

Selbstgebaute, **kostenlose** Web-App: prozeduraler V8-/Reihensechser-Motorsound im Tesla-Browser, gekoppelt an GPS-Geschwindigkeit (optional Handysensor).

Kein Account, kein Paywall, kein Tracking. Originalcode – keine Samples oder Assets von TesRev, Rupteur oder Brul.

## Im Tesla öffnen (Model Y Juniper)

1. Tesla online bringen (Premium Connectivity oder Handy-Hotspot).
2. Auf dem Touchscreen: **Apps → Browser**.
3. URL öffnen: **https://termingold.github.io/tesla-v8-sound/**
4. Einmal auf den Bildschirm tippen (Audio-Freigabe), dann **Start**.
5. Standort **erlauben**, damit die Geschwindigkeit folgt.
6. Lautstärke am Fahrzeugregler einstellen – Verkehr muss hörbar bleiben.

### Optional: Handy als Gas-Sensor

Der Tesla-Browser liefert oft **keine** DeviceMotion-Daten. Dieselbe URL am Handy (Halter) öffnen und Bewegung erlauben – schärferes Gas-Gefühl, auch im Tunnel hilfreich. Die Synthese läuft weiter im Tesla (oder nur am Handy über Bluetooth/Kabel, je nach Setup). Für die Kabine reicht meist die Tesla-Seite mit GPS.

### Simulation (ohne Fahren)

**Simulation** einschalten und mit **+ 10 / − 10 km/h** Drehzahl und Gänge testen. **Halten = Gas** zum Hochdrehen im Stand.

## Funktionen

- Start / Stopp, Lautstärke
- Motortypen: V8 Cross-Plane, V8 Flat-Plane, Reihensechser (alles Web-Audio, kein Sample)
- Geschwindigkeit per Geolocation (`watchPosition`), Anzeige in km/h
- Optionale DeviceMotion (Gas-Hinweis)
- Gangwechsel per Buttons und Tastatur (↑/↓, +/−; Tesla-Scrollrad kann Tasten senden – modellabhängig)
- Dunkle, große Touch-UI (~1280 px)
- Deutsche Beschriftung
- Optionaler Service Worker für Offline nach erstem Laden

## Rechtliches / Hinweis DE

Nur Kabinennutzung. Keine externe Beschallung im öffentlichen Straßenverkehr. Lautstärke so, dass Umgebung hörbar bleibt. Keine Verbindung zu Fahrzeugsystemen – reine Webseite.

## Lokal starten

```bash
cd tesla-v8-sound
python3 -m http.server 8080
# dann http://localhost:8080 öffnen
```

Geolocation und Audio brauchen HTTPS (oder localhost).



## YouTube als Klang-Vorbild (nur Charakterisierung)

Wir haben **keinen** YouTube-Ton heruntergeladen, gerippt oder eingebettet — das wäre urheberrechtlich unzulässig.
Stattdessen öffentliche Clips als **Hörreferenz** genutzt und unseren eigenen Web-Audio-Synthesizer darauf abgestimmt:

| Refernz | URL | Hör-Charakter (Stichworte) |
|--------|-----|----------------------------|
| Mustang GT 5.0 Cold Start / Active Exhaust | https://www.youtube.com/watch?v=Fhhvj4Usz_Y | Cold Start, uneven idle burble, exhaust modes |
| Mustang GT 5.0 Exhaust + Acceleration | https://www.youtube.com/watch?v=-UG5YrWDKuY | Deep rumble → rising growl under load |
| C8 Corvette mic’d engine/exhaust | https://www.youtube.com/watch?v=jeOFpFCnBUM | LT2 small-block note, cabin vs tip |
| Hellcat / loud V8 exhaust | https://www.youtube.com/watch?v=I-CTCooJR-I | Aggressive volume, idle presence |
| AMG V8 pops/crackles | https://www.youtube.com/watch?v=ZRgyuYLYgpE | Overrun pops & bangs on lift-off / downshift |

**Primärziel:** amerikanischer Cross-Plane-Muscle-V8 (Coyote/LT2-Stil): starker Leerlauf-Lope, tiefer Brustton, Midrange-„Bark“ unter Last, deutliche Crackles beim Gaswegnehmen.

Zusätzliche Text-Referenz (kein YouTube): [getcarsounds.com Mustang GT](https://getcarsounds.com/sounds/ford-mustang-gt/) — erklärt Cross-Plane-Burble und ~67 Hz bei 1000 rpm.

v5 war reine Synthese; ab v6 optional Freesound CC-BY/CC0 (siehe oben).

## Sound-Upgrade (prozedural)

Charakter angelehnt an öffentlich beschriebene Demo-Muster (Leerlauf → Launch → Schalten → Lift-off/Crackle → Kickdown) – **ohne** Fremd-Samples oder -Code.

Neu/verbessert (Muscle-Retune):
- Stärkerer Cross-Plane-**Lope** / Burble im Leerlauf (Coyote-Charakter)
- Dynamischer Midrange-**Bark** unter Last
- Tieferer Sub/Brustton, aggressivere Auspuff-Lage
- Hellcat/AMG-angelehnte **Overrun-Crackles**
- **Demo-Fahrt ~22 s**: langer Idle → Blip → Launch → Lift-off-Crackles → Kickdown

### Ehrlicher Abstand zu TesRev / YouTube

TesRev und echte YouTube-Aufnahmen klingen dichter und „physischer“. Unsere App ist freie Original-Synthese: sie zielt auf denselben *Charakter* (Lope, Bark, Crackle), kann aber keine Aufnahme ersetzen und enthält **kein** YouTube-Audio.


## Technik

- `js/engine.js` – prozedurale Synthese (Oszillatoren, Filter, Rauschen, Schalt-Blips)
- `js/app.js` – UI, GPS, Motion, Simulation
- Keine Backend-Server, keine Analytics

## Lizenz

Frei nutzbar für den privaten Gebrauch. Keine TesRev/Rupteur/Brul-Inhalte enthalten.
