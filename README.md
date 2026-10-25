# Tesla V8 Sound (kostenlos)

Selbstgebaute, **kostenlose** Web-App: prozeduraler V8-/Reihensechser-Motorsound im Tesla-Browser, gekoppelt an GPS-Geschwindigkeit (optional Handysensor).

Kein Account, kein Paywall, kein Tracking. Originalcode – keine Samples oder Assets von TesRev, Rupteur oder Brul.

## Im Tesla öffnen (Model Y Juniper)

1. Tesla online bringen (Premium Connectivity oder Handy-Hotspot).
2. Auf dem Touchscreen: **Apps → Browser**.
3. URL dieser Seite öffnen (GitHub Pages-Link, siehe unten).
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

## Technik

- `js/engine.js` – prozedurale Synthese (Oszillatoren, Filter, Rauschen, Schalt-Blips)
- `js/app.js` – UI, GPS, Motion, Simulation
- Keine Backend-Server, keine Analytics

## Lizenz

Frei nutzbar für den privaten Gebrauch. Keine TesRev/Rupteur/Brul-Inhalte enthalten.
