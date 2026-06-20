/* ============================================================
   Story-/Dialog-Visualizer — Parse-Schicht
   Reines Vanilla-JS, keine Build-Tools (Vorbild: class-tree-visualizer).

   Aufgabe dieser Datei: rohe Tab-Zeilen (string[][]) -> getippte
   Datensätze pro Tab. Die Kopfzeile wird – wie beim Klassen-Tool –
   AUTOMATISCH gesucht (manche Tabs haben eine Info-/Notizzeile in A1).
   Keine Quelle wird hier angesprochen; das macht die Adapter-Schicht
   (sources.js). So bleibt das Format quellen-unabhängig.
   ============================================================ */
(function () {
  "use strict";
  const SDV = (window.SDV = window.SDV || {});

  /* CSV-Parser, RFC-4180 genug (Quotes, "" -> ", \r\n, BOM).
     1:1 aus class-tree-visualizer übernommen, damit die Google-Sheet-CSV
     (Stufe 2) exakt gleich geparst wird wie dort. */
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM
    const rows = [];
    let row = [], field = "", inQuotes = false, i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    row.push(field);
    rows.push(row);
    return rows.filter(r => r.some(f => f.trim() !== ""));
  }

  // "set_flag:K=V; signal:X; remove_unit:Y" -> [{op,arg}] bzw. Flag-Liste.
  // Mehrere Effekte sind mit ";" getrennt (Konvention laut _Anleitung-Tab).
  function splitEffects(value) {
    if (!value) return [];
    return value.split(";").map(s => s.trim()).filter(Boolean);
  }

  /* Aus einer Liste von Effekt-Strings die Flag-SCHREIBVORGÄNGE ziehen.
     Erkennt "set_flag:KEY=VALUE". Andere Effekte (signal:, start_timeline:,
     remove_unit:, spawn_unit:) werden hier ignoriert – sie sind keine
     Flag-Brücken. Gibt [{flag, value}] zurück. */
  function parseSetFlags(value) {
    const out = [];
    for (const eff of splitEffects(value)) {
      const m = eff.match(/^set_flag\s*:\s*([^=]+)=(.*)$/i);
      if (m) out.push({ flag: m[1].trim(), value: m[2].trim() });
    }
    return out;
  }

  const norm = (s) => (s == null ? "" : String(s)).trim();

  /* Header-Zeile suchen: erste Zeile, die ALLE genannten Pflicht-Spalten
     enthält (case-insensitiv, exakter Zellen-Match). Damit werden Info-/
     Notizzeilen vor dem Header zuverlässig übersprungen. */
  function findHeader(rows, requiredCols) {
    const req = requiredCols.map(c => c.toLowerCase());
    return rows.findIndex(r => {
      const cells = r.map(c => norm(c).toLowerCase());
      return req.every(rc => cells.includes(rc));
    });
  }

  /* Tab (rohe Zeilen) -> Array von Objekten {spalte: wert}.
     requiredCols dient nur der Header-Erkennung; übernommen werden ALLE
     Spalten der gefundenen Kopfzeile. Leere Datenzeilen entfallen bereits
     in parseCSV / im Fixture. */
  function tableToRecords(rows, requiredCols, tabLabel) {
    if (!rows || !rows.length) throw new Error(`Tab "${tabLabel}": leer.`);
    const h = findHeader(rows, requiredCols);
    if (h === -1) {
      throw new Error(
        `Tab "${tabLabel}": keine Kopfzeile mit Spalten [${requiredCols.join(", ")}] gefunden.`);
    }
    const header = rows[h].map(norm);
    const records = [];
    for (let r = h + 1; r < rows.length; r++) {
      const cols = rows[r];
      const rec = {};
      let any = false;
      header.forEach((name, c) => {
        if (!name) return;
        const v = norm(cols[c]);
        rec[name] = v;
        if (v !== "") any = true;
      });
      if (any) records.push(rec);
    }
    return records;
  }

  SDV.parse = { parseCSV, tableToRecords, splitEffects, parseSetFlags, norm };
})();
