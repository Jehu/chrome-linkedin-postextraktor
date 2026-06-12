# LinkedIn PostExtraktor

Chrome-Extension (Manifest V3), die den gerade geöffneten LinkedIn-Post **samt
aller Kommentare und Antworten** als Markdown exportiert – wahlweise in die
Zwischenablage oder als `.md`-Datei.

## Features

- **Vollständiges Ausklappen:** Klickt selbstständig so lange auf
  „Weitere Kommentare laden", „Vorherige Antworten anzeigen",
  „X Antworten" und „… mehr (anzeigen)", bis nichts mehr nachgeladen wird
  (inklusive Scroll-Trigger für dynamisches Nachladen).
- **Virtualisierungs-fest:** LinkedIn entfernt beim Scrollen Off-Screen-
  Kommentare wieder aus dem DOM. Die Extension sammelt deshalb laufend per
  Kommentar-URN in eine Ernte-Map und macht am Ende einen kompletten
  Scroll-Sweep durch die Liste — es geht nichts verloren, auch wenn es
  gerade nicht gerendert ist.
- **Sortierung (Best-Effort):** Versucht, die Kommentar-Sortierung von
  „Relevanteste" auf „Neueste/Alle" umzustellen. Das LinkedIn-Dropdown
  reagiert allerdings nur auf echte Maus-Klicks, nicht auf programmatische —
  meist bleibt es bei „Relevanteste". Für die **Vollständigkeit** ist das
  unkritisch (alle Kommentare werden trotzdem geladen), nur die Reihenfolge
  im Export entspricht dann der Relevanz-Sortierung. Tipp: Vor dem Export
  manuell auf „Neueste" umstellen, wenn die chronologische Reihenfolge
  wichtig ist.
- **Markdown mit allen Metadaten:** Autor, Headline, Zeitstempel, Post-Text,
  Reaktions-/Kommentar-/Repost-Zahlen; Kommentare mit Autor, Headline, Zeit
  und Reaktionen; Antworten verschachtelt als Blockquotes.
- **Bilder inklusive:** Post- und Kommentarbilder werden erkannt (Avatare,
  Emojis und Reaktions-Icons werden herausgefiltert). Beim **Kopieren**
  landen sie als `![Bild](CDN-URL)` im Markdown (Achtung: LinkedIn-CDN-URLs
  sind signiert und laufen nach einiger Zeit ab). Beim **Speichern** lädt
  die Extension die Bilder zusätzlich herunter – alles zusammen in
  `Downloads/linkedin-export/<post>/` – und verlinkt sie relativ
  (`./<post>-bild-01.jpg`), sodass die `.md`-Datei dauerhaft funktioniert.
- **Kein Limit:** Lädt ohne Obergrenze – große Posts können ein bis zwei
  Minuten dauern (Fortschrittsanzeige im Popup). Abbrechen exportiert den
  bisherigen Stand.
- **Robust gegen geschlossenes Popup:** Läuft die Extraktion noch, während das
  Popup zu ist, liegt das Ergebnis beim nächsten Öffnen bereit
  (15 Minuten lang).
- **Plausibilitäts-Check:** Vergleicht die erfasste Kommentaranzahl mit der
  von LinkedIn gemeldeten Zahl und warnt bei Abweichungen.

## Installation

1. Chrome öffnen → `chrome://extensions/`
2. Oben rechts **Entwicklermodus** aktivieren
3. **„Entpackte Erweiterung laden"** → diesen Ordner
   (`linkedin-postextraktor`) auswählen
4. Optional: Extension in der Toolbar anpinnen

## Benutzung

1. Einen LinkedIn-Post öffnen – eine dedizierte Post-Seite, z. B.
   `linkedin.com/posts/…` oder `linkedin.com/feed/update/urn:li:activity:…`
   (im Feed: auf den Zeitstempel oder „Kommentare" des Posts klicken)
2. Auf das Extension-Icon klicken
3. **„Als Markdown kopieren"** oder **„Als .md-Datei speichern"** wählen
4. Warten, bis alle Kommentare ausgeklappt sind – Fortschritt wird angezeigt

Der Tab muss während der Extraktion geöffnet und sichtbar bleiben
(nicht minimieren), damit LinkedIn zuverlässig nachlädt.

## Markdown-Format

```markdown
# LinkedIn-Post von Max Mustermann

**Autor:** Max Mustermann — CEO bei Beispiel GmbH
**Veröffentlicht:** 3 Wochen
**URL:** https://www.linkedin.com/posts/…
**Engagement:** 1.234 Reaktionen · 56 Kommentare · 7 Mal geteilt

---

(Post-Text)

---

## Kommentare (42 + 13 Antworten)

### Erika Musterfrau
*Marketing Lead*
*2 Wochen · 5 Reaktionen*

Kommentartext …

> **↳ Max Mustermann** — *CEO bei Beispiel GmbH*
> *2 Wochen · 1 Reaktionen*
>
> Antworttext …
```

## Hinweise & Grenzen

- LinkedIn ändert seine CSS-Klassen regelmäßig. Der Extractor nutzt mehrere
  Fallback-Selektoren plus deutsch/englische Text-Erkennung der Buttons –
  sollte trotzdem etwas nicht mehr funktionieren, sind die Selektoren in
  `content.js` zentral gepflegt.
- Die gemeldete Kommentarzahl von LinkedIn enthält teils gelöschte oder
  eingeschränkt sichtbare Kommentare – kleine Abweichungen sind normal
  (Live-Test: 78 erfasst bei „80" gemeldeten, Rest gelöscht/eingeschränkt).
- Nur für den privaten Gebrauch; das automatisierte Auslesen kann gegen die
  LinkedIn-Nutzungsbedingungen verstoßen.

## Tests

- `test/fixture.html`: Regressionstest mit LinkedIn-nachgebautem DOM
  (dynamisches Nachladen, versteckte Antworten, gekürzte Texte, chrome-Stub).
  Ausführen: HTTP-Server im Projektordner starten
  (`python3 -m http.server 8766`), dann `http://127.0.0.1:8766/test/fixture.html`
  öffnen – das Ergebnis liegt in `window.__lipxStore.lipx_result`.
- Live-verifiziert am 12.06.2026 gegen einen echten Post mit 80 Kommentaren
  (44 Top-Level + 34 Antworten erfasst, inkl. DOM-Virtualisierung).

## Dateien

| Datei | Zweck |
|---|---|
| `manifest.json` | MV3-Manifest, Berechtigungen (`activeTab`, `scripting`, `storage`, `clipboardWrite`) |
| `popup.html/css/js` | UI: Buttons, Fortschritt, Ergebnis, Kopieren/Speichern |
| `content.js` | Ausklapp-Logik, DOM-Extraktion, Markdown-Erzeugung |
| `icons/` | Extension-Icons |

## Lizenz

[MIT](LICENSE)
