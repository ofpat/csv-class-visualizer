# Skill-Liste

Eigenständiges, statisches Web-Tool, das die Tabs **„Aktive Skills"** und
**„Passive Skills"** aus dem Google Sheet zu **einer** durchsuch- und
filterbaren Liste kombiniert.

Gehört zum [Klassenbaum-Visualizer](../class-tree-visualizer/) – beide liegen
unter `tools/` und teilen sich die Sheet-URL über `localStorage` (gleicher
Schlüssel `ktv-settings-v2`, gleiche Origin). Die URL muss also nur **einmal** in
einem der beiden Tools eingegeben werden.

## Funktionen

- **Kombinierte Liste** aus aktiven + passiven Skills, jeweils farblich/Badge
  gekennzeichnet.
- **Suche** über Name **und** Beschreibung.
- **Filter** Alle / Aktiv / Passiv.
- Zeigt zusätzlich die typ-spezifischen Spalten (Aktiv: *Ziel*, *Effekt*;
  Passiv: *Bedingung*, *Ziel*).
- **Deep-Link** `#skill=<Name>`: Der Klassenbaum-Visualizer verlinkt von einer
  Fähigkeit direkt hierher – der Skill wird hervorgehoben und angescrollt.
- **↻ Neu laden** holt den aktuellen Stand aus dem Sheet.

## Datenquelle / GIDs

Erwartete Tab-Struktur (Kopfzeile mit Spalte `Name`; eine Info-Zeile darüber
wird automatisch übersprungen):

```
# Aktive Skills:   Name, Beschreibung, Ziel (…), Effekt
# Passive Skills:  Name, Beschreibung, Bedingung, Ziel
```

Die GIDs der beiden Tabs sind in `app.js` als `SKILL_GIDS` hinterlegt (reine
Tab-Nummern, ohne den Sheet-Token wertlos). Falls sich die Tabs ändern, dort
anpassen.

## Lokal testen / Deploy

Identisch zum Klassenbaum-Tool: Für den Live-Abruf über `http://localhost`
(`python -m http.server`) oder GitHub Pages laufen lassen – **nicht** per
Doppelklick (`file://` → CORS `origin 'null'`). Siehe
[../class-tree-visualizer/README.md](../class-tree-visualizer/README.md).
