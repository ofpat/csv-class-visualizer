/* ============================================================
   Story-/Dialog-Visualizer — Datenquellen-Adapter
   ============================================================
   Einheitliche Schnittstelle für ALLE Quellen:

       source.fetchTabs(tabNames) -> Promise<{ [tab]: string[][] }>

   Eine Quelle liefert pro angefragtem Tab die ROHEN Zeilen (genau das,
   was parseCSV erzeugt). Damit ist die Quelle frei austauschbar, ohne
   dass Parse-Schicht oder Graph-Modell etwas ändern müssen:

     • Stufe 1 (jetzt, Entwicklung):  LocalFixtureSource
         liest die eingebetteten xlsx-Tabs (data/fixture.js).
     • Stufe 2 (später, Ziel):        GoogleSheetSource
         lädt je Tab eine CSV vom veröffentlichten Google-Sheet –
         identisch zum class-tree-visualizer (buildCsvUrl + fetch).

   Tab-Namen sind die KANONISCHE Identität (characters, lines, …). Die
   Google-Sheet-Quelle bildet Tab-Name -> GID ab (gleiche Tabs als
   einzelne Sheets, wie vom Sheet-Setup vorgegeben).
   ============================================================ */
(function () {
  "use strict";
  const SDV = (window.SDV = window.SDV || {});
  const { parseCSV } = SDV.parse;

  /* ---------- Stufe 1: eingebettetes xlsx-Fixture ----------
     Die Tabs liegen bereits als string[][] vor (aus der xlsx erzeugt).
     Async-Signatur beibehalten, damit der Aufrufer für beide Quellen
     identisch ist. */
  function LocalFixtureSource(fixture) {
    const data = fixture || SDV.FIXTURE || {};
    return {
      kind: "fixture",
      label: "Eingebettetes xlsx-Template (Dev)",
      async fetchTabs(tabNames) {
        const out = {};
        for (const tab of tabNames) {
          if (!data[tab]) throw new Error(`Fixture: Tab "${tab}" fehlt.`);
          // Defensive Kopie, damit Konsumenten die Fixture nicht mutieren.
          out[tab] = data[tab].map(r => r.slice());
        }
        return out;
      },
    };
  }

  /* ---------- Stufe 2: Google-Sheet (CSV je Tab) ----------
     buildCsvUrl ist bewusst 1:1 die Logik aus class-tree-visualizer
     (app.js:717), damit sich beide Tools exakt gleich an ein Sheet binden. */
  function buildCsvUrl(ref, gid) {
    ref = (ref || "").trim();
    let m = ref.match(/\/d\/e\/([^\/?#]+)/);
    if (m) return `https://docs.google.com/spreadsheets/d/e/${m[1]}/pub?output=csv&single=true&gid=${encodeURIComponent(gid)}`;
    if (/^2PACX/i.test(ref)) return `https://docs.google.com/spreadsheets/d/e/${ref}/pub?output=csv&single=true&gid=${encodeURIComponent(gid)}`;
    m = ref.match(/\/d\/([^\/?#]+)/);
    const id = m ? m[1] : ref;
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${encodeURIComponent(gid)}`;
  }

  /* sheetRef: Publish-URL / 2PACX-Token / Spreadsheet-ID.
     gidMap:   { tabName: "gid", ... } – muss alle benötigten Tabs abdecken. */
  function GoogleSheetSource(sheetRef, gidMap) {
    return {
      kind: "google-sheet",
      label: "Google Sheet (live CSV)",
      buildCsvUrl,
      async fetchTabs(tabNames) {
        if (!sheetRef) throw new Error("Keine Sheet-URL/ID konfiguriert.");
        const pairs = await Promise.all(tabNames.map(async (tab) => {
          const gid = gidMap && gidMap[tab];
          if (gid == null) throw new Error(`Keine GID für Tab "${tab}" hinterlegt.`);
          const url = buildCsvUrl(sheetRef, gid);
          const resp = await fetch(url, { redirect: "follow" });
          if (!resp.ok)
            throw new Error(`Tab "${tab}" (gid=${gid}): HTTP ${resp.status}. URL/GID prüfen und ob das Sheet „Im Web veröffentlicht“ ist.`);
          const text = await resp.text();
          if (/^\s*<(!doctype|html)/i.test(text))
            throw new Error(`Tab "${tab}" (gid=${gid}): Antwort war HTML statt CSV. „Im Web veröffentlichen“ aktiv?`);
          return [tab, parseCSV(text)];
        }));
        const out = {};
        for (const [tab, rows] of pairs) out[tab] = rows;
        return out;
      },
    };
  }

  SDV.sources = { LocalFixtureSource, GoogleSheetSource, buildCsvUrl };
})();
