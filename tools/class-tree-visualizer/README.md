# Klassenbaum-Visualizer

Ein eigenständiges, statisches Web-Tool zur Visualisierung von Klassenbäumen
(Skill-Trees) für die Entwicklung eines taktischen RPGs. Es liest die
Klassendaten **live** aus einem öffentlich freigegebenen Google Sheet oder aus
einer **lokalen CSV-Datei** als Fallback.

> **Datenmodell:** Ein *Baum* wird aus **einem oder mehreren Tabs** (GIDs)
> zusammengeführt. Im aktuellen Sheet sind die Klassen z.B. auf vier Tier-Tabs
> verteilt (*Klasse Basic*, *Klasse Tier 1/2/3*), die gemeinsam **einen**
> Klassenbaum ergeben. Voraussetzungen verlinken über Tab-Grenzen hinweg; die
> Tier-Ebene ergibt sich automatisch aus der Graphstruktur.

> Reines HTML/CSS/Vanilla-JavaScript. Keine Build-Tools, kein npm, kein Backend.
> Nur `localStorage` für UI-Komfort (gespeicherte Einstellungen).

Dies ist ein **Design-Tool** und **nicht Teil des Godot-Spiels**. Es schreibt
niemals ins Google Sheet, es liest nur.

---

## Funktionen

- **Live-Abruf aus Google Sheets**; ein Baum kann **mehrere Tabs zusammenführen**.
- Unterstützt **„Im Web veröffentlichen“-URLs** (`…/d/e/…/pub`) **und** normale
  Spreadsheet-IDs (`/export`).
- **Kopfzeile wird automatisch erkannt** – eine Info-Zeile in A1 wird übersprungen.
- **Lokaler CSV-Upload** (Datei-Button **und** Drag & Drop) als Fallback/Offline.
- **Automatisches Tier-Layout**: Tiers ergeben sich aus der Graphstruktur
  (Wurzeln = keine Voraussetzung; Tier = max(Eltern-Tier)+1). Trennzeichen für
  Voraussetzungen/Waffen: `,` **oder** `/`.
- **Mehrere Bäume** parallel über eine Tab-Leiste; jeder Baum behält eigenen
  Zoom/Pan-Zustand und wird unabhängig neu geladen.
- **Subtree-Fokus**: Klick auf eine Klasse zeigt nur deren Linie (alle Vorfahren
  **und** alle Nachkommen) und ordnet sie kompakt neu an. Erneuter Klick / Klick
  ins Leere hebt den Fokus auf.
- **Filter-Sidebar** (links): gruppiert die Klassen nach **Waffen-** und
  **Rüstungstypen**. Die Kategorien werden **aus den vorhandenen Daten abgeleitet**
  (Spalten *Waffe*/*Rüstung*) – hinter jeder steht die Anzahl der Klassen, z.B.
  *Schwert (2)*. Klick filtert den Baum: die passenden Klassen **inkl. ihres
  Tier-Pfades nach oben** (alle Vorfahren bis zur Wurzel) bleiben hervorgehoben,
  der Rest wird abgeblendet. **Mehrfachauswahl** ist möglich (ODER-Verknüpfung);
  **„Alle anzeigen"** setzt zurück. Filter und Subtree-Fokus sind entkoppelt: ein
  Klick auf eine Karte fokussiert wie gewohnt, danach kehrt das Filter-Dimmen
  zurück.
- **Verlinkte Fähigkeiten**: Aktiv-/Passiv-Einträge, die einem Skill aus den
  Tabs *Aktive/Passive Skills* entsprechen, sind verlinkt – **Hover** zeigt die
  Beschreibung, **Klick** öffnet die [Skill-Liste](../skill-list/) beim Skill.
- **Mischklassen** (von mehreren Pfaden erreichbar) farblich markiert.
- **Interaktion**: Hover hebt Eltern + Kinder hervor, Klick pinnt die Auswahl,
  Zoom (Mausrad / +/-) und Pan (Drag auf leerer Fläche), Suchfeld.
- **Export** des sichtbaren Baums als **PNG** oder **SVG**.

---

## Lokal testen

### Variante A – einfacher Doppelklick
`index.html` per Doppelklick öffnen.

- **Lokaler CSV-Upload funktioniert sofort** (Datei-Button oder Drag & Drop).
- ⚠ Der **Google-Sheets-Live-Abruf funktioniert hier NICHT.** Beim
  `file://`-Protokoll ist die Origin `null`, und Google sendet dafür keine
  CORS-Header (`No 'Access-Control-Allow-Origin' header … origin 'null'`).

### Variante B – kleiner lokaler Server (für Live-Abruf nötig)
Im Tool-Ordner:

```bash
python -m http.server 8000
# dann im Browser: http://localhost:8000/
```

Über `http://localhost` ist die Origin echt, und der Live-Abruf funktioniert.

> **CORS – getestet:** Der CSV-Export öffentlich veröffentlichter Sheets sendet
> für **echte Origins** korrekte CORS-Header
> (`access-control-allow-origin: *` bzw. die angefragte Origin). Damit
> funktioniert der Abruf von **GitHub Pages** und von **`http://localhost`**
> einwandfrei – **nur `file://` (Doppelklick) scheitert** an `origin 'null'`.
> Für diesen Fall bleibt der lokale CSV-Upload der zuverlässige Fallback.

### Sheet-Link wird nicht committet
Im Repo ist **bewusst keine Sheet-URL** hinterlegt. Beim ersten Start fragt die
Seite den Link ab (oder über ⚙ Einstellungen) und speichert ihn **nur lokal in
`localStorage`**. So landet die `docs.google.com`-Adresse nie im Git-Repo. Die
GIDs (reine Tab-Nummern, ohne Token wertlos) sind als Komfort vorbelegt.

---

## Google Sheet einrichten

1. Im Google Sheet: **Datei → Freigeben → Im Web veröffentlichen** aktivieren
   (öffentlich per Link lesbar; muss nicht beworben/verlinkt werden).
2. Die veröffentlichte **CSV-URL** kopieren (Form `…/d/e/<TOKEN>/pub?output=csv`)
   **oder** alternativ die normale **Spreadsheet-ID** (Teil zwischen `/d/` und
   `/edit`).
3. Für jeden Tab, der in den Baum soll, die **GID** notieren — der Wert `gid=…`
   in der Sheet-URL, wenn der jeweilige Tab aktiv ist.
4. Im Tool **⚙ Einstellungen** öffnen:
   - **Sheet-URL oder ID** eintragen.
   - Unter **Bäume** je einen Baum mit **Name** + den zugehörigen
     **GIDs (kommagetrennt)** anlegen. Mehrere GIDs werden zu einem Baum
     zusammengeführt.
   - **Speichern & Laden**.

> Das Tool ist bereits mit dem aktuellen Sheet vorbelegt (ein Baum
> *„Klassenbaum“* aus den vier Tier-Tabs). Beim ersten Start lädt es direkt.

Die Konfiguration wird in `localStorage` gespeichert und ist beim nächsten Besuch
wieder da. Mit **↻ Neu laden** (pro Baum) bzw. **↻↻ Alle** holt man jederzeit den
aktuellen Stand aus dem Sheet, ohne die Seite neu zu laden.

### CSV-URLs (intern verwendet)
```
# „Im Web veröffentlichen“:
https://docs.google.com/spreadsheets/d/e/{TOKEN}/pub?output=csv&single=true&gid={TAB_GID}
# normale Spreadsheet-ID:
https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/export?format=csv&gid={TAB_GID}
```

---

## Eingabeformat

Kopfzeile mit (mindestens) der Spalte **`Klasse`**. Die Kopfzeile darf eine
beliebige Info-/Beschreibungszeile **darüber** haben (z.B. in A1) – sie wird
automatisch übersprungen. Empfohlene Spalten:

```
Klasse,Voraussetzung,Waffe,Rüstung,Passive Fähigkeiten,Aktive Fähigkeiten
```

- **Voraussetzung**: Liste von Klassennamen, getrennt durch `,` **oder** `/`
  (bei mehreren im CSV-Feld in Anführungszeichen). Leer/Spalte fehlt =
  Wurzelknoten (Tier 0). Voraussetzungen dürfen auf Klassen aus **anderen Tabs**
  desselben Baums zeigen.
- **Waffe** / **Rüstung**: mehrere Werte, getrennt durch `,` oder `/`.
- **Passive/Aktive Fähigkeiten**: Freitext, dürfen leer sein.
- Nicht aufgelöste Voraussetzungen werden auf der Karte als ⚠ markiert
  (statt still zu scheitern).

Spalten dürfen je Tab variieren (z.B. hat ein „Basic“-Tab keine Spalte
*Voraussetzung*). Eine Beispieldatei liegt bei: [`beispiel.csv`](beispiel.csv).

---

## Über GitHub Pages deployen

Rein statische Dateien, alle Pfade relativ (`style.css`, `app.js`) – kein
Backend nötig. **Die Sheet-URL wird nicht mitveröffentlicht** (siehe oben); jeder
Besucher fügt seinen Link einmalig selbst ein, er bleibt in dessen Browser.

### Variante 1 – Unterordner im (Spiel-)Repo  *(empfohlen)*

Wenn dieser Ordner im Repo unter `tools/class-tree-visualizer/` liegt:

```bash
# einmalig, falls noch kein Repo:
cd <repo-wurzel>
git init
git add .
git commit -m "Add class-tree visualizer tool"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

Dann auf GitHub: **Settings → Pages → Source: „Deploy from a branch" →
Branch `main`, Ordner `/ (root)` → Save.**

Aufrufbar unter:
`https://<user>.github.io/<repo>/tools/class-tree-visualizer/`

> GitHub Pages kann nicht direkt auf einen Unterordner als Site-Root zeigen,
> daher steht der Pfad in der URL. Wegen der relativen Pfade funktioniert das
> ohne Anpassung.

### Variante 2 – Eigenes Repo nur für das Tool  *(kürzeste URL)*

Inhalt **dieses Ordners** in den Root eines neuen Repos legen, Pages auf
`main / root` stellen. Aufrufbar dann unter
`https://<user>.github.io/<tool-repo>/` (ohne Unterpfad).

### Variante 3 – `gh-pages`-Branch

Tool-Inhalt in den Root eines `gh-pages`-Branches, Pages-Source auf
`gh-pages / root`.

> **Hinweis zur Sichtbarkeit:** GitHub Pages ist öffentlich erreichbar. Da das
> Sheet ohnehin „im Web veröffentlicht" (öffentlich lesbar per Link) ist und die
> URL nicht im Repo steht, ist das für dieses Projekt unkritisch. Wer es ganz
> privat will, nutzt GitHub Pages mit einem **privaten Repo** (Pro-Feature) oder
> lässt das Tool nur lokal über `http://localhost` laufen.

---

## Abnahme mit der Beispieldatei

1. Tool öffnen, **⚙ Einstellungen → Lokale CSV laden…** und `beispiel.csv` wählen
   (oder die Datei per Drag & Drop ablegen).
2. Erwartetes Ergebnis:
   - **Zivilist**, **Rekrut**, **Verstossener** erscheinen als Tier-0-Wurzeln.
   - **Söldner** hat Linien zu *Zivilist* **und** *Rekrut*; **Dieb** zu *Zivilist*
     **und** *Verstossener* (beide als Mischklasse markiert).
   - Alle Fähigkeitstexte sind in den Karten lesbar.
   - Hover über *Zivilist* hebt alle direkten Kind-Klassen hervor.
3. **Filter-Sidebar** prüfen:
   - Links erscheinen die Sektionen *Waffen* und *Rüstung* mit Anzahlen, z.B.
     *Schwert (2)*, *Dolch (2)*, *Leichte Rüstung (6)*, *Keine Rüstung (3)*.
   - Klick auf **Schwert** lässt nur *Söldner*/*Knappe* **plus deren Tier-Pfad**
     (*Zivilist*, *Rekrut*) hervorgehoben; der Rest wird abgeblendet.
   - Eine zweite Kategorie (z.B. *Dolch*) erweitert die Auswahl (ODER); erneuter
     Klick hebt sie auf. **„Alle anzeigen"** setzt den Filter zurück.
