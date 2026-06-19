/* ============================================================
   Klassenbaum-Visualizer
   Reines Vanilla-JS, keine Build-Tools.

   Modell:
   - Ein "Baum" wird aus EINEM oder MEHREREN Google-Sheet-Tabs
     (GIDs) zusammengeführt. Beispiel: Basic + Tier1 + Tier2 + Tier3
     ergeben gemeinsam einen Klassenbaum. Voraussetzungen verlinken
     über Tab-Grenzen hinweg.
   - Tiers ergeben sich aus der Graphstruktur (Wurzel = keine
     Voraussetzung; Tier = max(Eltern-Tier)+1).
   - Datenquelle: "Im Web veröffentlichen"-URL (…/d/e/…/pub) ODER
     normale Spreadsheet-ID (/export). Lokaler CSV-Upload als Fallback.
   - Die Kopfzeile wird automatisch erkannt (eine Info-Zeile in A1
     wird übersprungen).
   ============================================================ */

"use strict";

const LS_KEY = "ktv-settings-v2";
const CARD_WIDTH = 240;        // muss zur Breite in style.css passen
const H_GAP = 36;              // horizontaler Abstand zwischen Karten
const V_GAP = 90;              // vertikaler Abstand zwischen Tiers
const PADDING = 80;            // Rand um das Layout

/* Vorbelegung. Wird nur genutzt, wenn noch nichts gespeichert ist.
   WICHTIG: Hier wird BEWUSST keine Sheet-URL hartcodiert – die Adresse soll
   nicht ins Repo committet werden, sondern auf der Seite eingegeben und nur in
   localStorage gespeichert werden. Die GIDs sind reine Tab-Nummern (ohne den
   Sheet-Token wertlos) und bleiben als Komfort-Vorbelegung erhalten. */
const DEFAULT_SETTINGS = {
  sheetRef: "",
  trees: [
    { name: "Klassenbaum", gids: ["1911903085", "1899139143", "569475736", "199939434"] },
  ],
};

/* ---------- globaler Zustand ---------- */
const state = {
  settings: { sheetRef: "", trees: [] },  // trees: [{name, gids:[...]}]
  trees: {},          // name -> tree-Objekt (Laufzeit)
  activeName: null,
};

/* tree-Objekt (Laufzeit):
   { name, source:'sheet'|'local', gids:[], csvText, nodes:[], byKey:{},
     warnings:[], error, loading, view:{scale,tx,ty,initialized}, focusKey } */

/* ---------- DOM-Referenzen ---------- */
const el = {
  treeTabs:    document.getElementById("treeTabs"),
  viewport:    document.getElementById("viewport"),
  canvas:      document.getElementById("canvas"),
  edges:       document.getElementById("edges"),
  nodes:       document.getElementById("nodes"),
  overlay:     document.getElementById("overlay"),
  overlaySpinner: document.getElementById("overlaySpinner"),
  overlayMsg:  document.getElementById("overlayMsg"),
  overlayActions: document.getElementById("overlayActions"),
  searchInput: document.getElementById("searchInput"),
  settingsPanel: document.getElementById("settingsPanel"),
  sheetRefInput: document.getElementById("sheetRefInput"),
  treeListEl:  document.getElementById("treeList"),
  fileInput:   document.getElementById("fileInput"),
  dropHint:    document.getElementById("dropHint"),
};

/* ============================================================
   CSV-Parser (RFC-4180-konform genug: Quotes, "" -> ", \n/\r\n)
   ============================================================ */
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

// Reine Komma-Trennung (für GID-Listen in den Settings).
function splitList(value) {
  if (!value) return [];
  return value.split(",").map(s => s.trim()).filter(Boolean);
}
// Voraussetzungen sowie Waffen/Rüstung sind im Sheet uneinheitlich mit
// "," ODER "/" getrennt (z.B. "Zivilist, Rekrut" aber "Bauer / Jäger").
// Beides bedeutet "alternativ erreichbar" bzw. "mehrere Optionen".
function splitMulti(value) {
  if (!value) return [];
  return value.split(/[,\/]/).map(s => s.trim()).filter(Boolean);
}

const keyOf = (name) => name.trim().toLowerCase();

/* ============================================================
   Sheet-/CSV-Tab -> Klassen-Teilliste
   Kopfzeile wird automatisch gesucht (Zeile mit Spalte "Klasse"),
   damit eine Info-Zeile in A1 problemlos übersprungen wird.
   Tabs dürfen unterschiedliche Spalten haben (z.B. Basic ohne
   "Voraussetzung").
   ============================================================ */
function parseSheetToClasses(csvText, tabLabel) {
  const rows = parseCSV(csvText);
  if (rows.length === 0) throw new Error(`Tab ${tabLabel || ""}: leer.`);

  let headerIdx = rows.findIndex(r =>
    r.some(c => c.trim().toLowerCase() === "klasse"));
  if (headerIdx === -1) {
    // Fallback: vielleicht enthält die erste Zeile "klasse" als Teilstring
    headerIdx = rows.findIndex(r => r.some(c => c.trim().toLowerCase().includes("klasse")));
  }
  if (headerIdx === -1) {
    throw new Error(
      `Tab ${tabLabel || ""}: keine Kopfzeile mit Spalte "Klasse" gefunden.\n` +
      `Erwartet wird eine Zeile wie: Klasse,Voraussetzung,Waffe,Rüstung,Passive Fähigkeiten,Aktive Fähigkeiten`
    );
  }

  const header = rows[headerIdx].map(h => h.trim().toLowerCase());
  const findCol = (...names) => header.findIndex(h => names.some(nm => h.includes(nm)));
  const idx = {
    klasse:  findCol("klasse"),
    voraus:  findCol("voraussetzung", "voraus"),
    waffe:   findCol("waffe"),
    ruest:   findCol("rüstung", "ruestung", "rustung"),
    passiv:  findCol("passive"),
    aktiv:   findCol("aktive"),
  };

  const parts = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const cols = rows[r];
    const name = (cols[idx.klasse] || "").trim();
    if (!name) continue; // leere/Notiz-Zeilen im Tab überspringen
    parts.push({
      name,
      key: keyOf(name),
      prereqNames: idx.voraus  >= 0 ? splitMulti(cols[idx.voraus]) : [],
      weapons:     idx.waffe   >= 0 ? splitMulti(cols[idx.waffe]) : [],
      armor:       idx.ruest   >= 0 ? splitMulti(cols[idx.ruest]) : [],
      passive:    (idx.passiv  >= 0 ? cols[idx.passiv] : "").trim(),
      active:     (idx.aktiv   >= 0 ? cols[idx.aktiv]  : "").trim(),
      tab: tabLabel || "",
    });
  }
  return parts;
}

/* Mehrere Tab-Teillisten zu einem Baum zusammenführen. */
function buildTreeFromParts(parts) {
  const nodes = [], byKey = {}, warnings = [];
  for (const p of parts) {
    if (byKey[p.key]) {
      warnings.push(`Doppelte Klasse "${p.name}"${p.tab ? ` (Tab ${p.tab})` : ""} – übersprungen.`);
      continue;
    }
    const node = Object.assign({}, p, { children: [], missingPrereqs: [], tier: 0 });
    nodes.push(node);
    byKey[p.key] = node;
  }
  for (const node of nodes) {
    node.prereqs = [];
    for (const pn of node.prereqNames) {
      const parent = byKey[keyOf(pn)];
      if (parent) { node.prereqs.push(parent); parent.children.push(node); }
      else node.missingPrereqs.push(pn);
    }
    node.isMixed = node.prereqs.length > 1;
    node.isRoot = node.prereqNames.length === 0;
  }
  computeTiers(nodes);
  return { nodes, byKey, warnings };
}

// Einzelne CSV (lokaler Upload) -> Baum.
function buildTree(csvText) {
  return buildTreeFromParts(parseSheetToClasses(csvText, "CSV"));
}

// Tier per Fixpunkt-Iteration: tier = max(parent.tier)+1, Wurzel = 0.
// Zyklen werden über das Iterationslimit abgefangen.
function computeTiers(nodes) {
  nodes.forEach(n => { n.tier = 0; });
  const maxIter = nodes.length + 1;
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (const n of nodes) {
      if (n.prereqs.length === 0) continue;
      const t = Math.max(...n.prereqs.map(p => p.tier)) + 1;
      if (t !== n.tier) { n.tier = t; changed = true; }
    }
    if (!changed) break;
  }
}

/* ============================================================
   Layout: Tiers von oben nach unten, Karten nebeneinander.
   ============================================================ */
function layoutAndRender(tree) {
  el.nodes.innerHTML = "";
  el.edges.innerHTML = "";
  const nodes = tree.nodes;
  if (nodes.length === 0) return;

  for (const node of nodes) {
    node._edges = [];
    node.el = createCard(node);
    el.nodes.appendChild(node.el);
  }
  for (const node of nodes) node.h = node.el.offsetHeight;

  const tiers = [];
  for (const node of nodes) (tiers[node.tier] = tiers[node.tier] || []).push(node);

  let maxTierWidth = 0;
  const tierWidths = tiers.map(group => {
    if (!group) return 0;
    const w = group.length * CARD_WIDTH + (group.length - 1) * H_GAP;
    maxTierWidth = Math.max(maxTierWidth, w);
    return w;
  });

  let y = PADDING;
  for (let t = 0; t < tiers.length; t++) {
    const group = tiers[t];
    if (!group) continue;
    group.sort((a, b) => a.name.localeCompare(b.name, "de"));
    let x = PADDING + (maxTierWidth - tierWidths[t]) / 2;
    let maxH = 0;
    for (const node of group) {
      node.x = x; node.y = y;
      node.el.style.left = x + "px";
      node.el.style.top = y + "px";
      x += CARD_WIDTH + H_GAP;
      maxH = Math.max(maxH, node.h);
    }
    y += maxH + V_GAP;
  }

  const totalWidth = maxTierWidth + PADDING * 2;
  const totalHeight = y - V_GAP + PADDING;
  el.edges.setAttribute("width", totalWidth);
  el.edges.setAttribute("height", totalHeight);
  el.edges.style.width = totalWidth + "px";
  el.edges.style.height = totalHeight + "px";
  el.canvas.style.width = totalWidth + "px";
  el.canvas.style.height = totalHeight + "px";

  tree._edgeList = [];
  for (const node of nodes) {
    for (const parent of node.prereqs) {
      const path = drawEdge(parent, node);
      node._edges.push(path);
      parent._edges.push(path);
      tree._edgeList.push({ path, from: parent.key, to: node.key });
    }
  }
}

function createCard(node) {
  const card = document.createElement("div");
  card.className = "card" + (node.isRoot ? " root" : "") + (node.isMixed ? " mixed" : "");
  card.dataset.key = node.key;

  const rows = [];
  rows.push(`<div class="card-title">
      <span>${esc(node.name)}</span>
      ${node.isMixed ? '<span class="mixed-badge">Misch</span>' : ""}
      <span class="tier-badge">T${node.tier}</span>
    </div>`);
  if (node.weapons.length)
    rows.push(`<div class="card-row"><span class="lbl">Waffe:</span> ${esc(node.weapons.join(", "))}</div>`);
  if (node.armor.length)
    rows.push(`<div class="card-row"><span class="lbl">Rüstung:</span> ${esc(node.armor.join(", "))}</div>`);
  if (node.passive)
    rows.push(`<div class="card-row passive"><span class="lbl">Passiv:</span> ${esc(node.passive)}</div>`);
  if (node.active)
    rows.push(`<div class="card-row active"><span class="lbl">Aktiv:</span> ${esc(node.active)}</div>`);
  if (node.missingPrereqs.length)
    rows.push(`<div class="card-row" style="color:#e6938a"><span class="lbl">⚠ fehlende Voraussetzung:</span> ${esc(node.missingPrereqs.join(", "))}</div>`);

  card.innerHTML = rows.join("");
  card.addEventListener("mouseenter", () => { if (!getActiveTree().focusKey) highlight(node); });
  card.addEventListener("mouseleave", () => { if (!getActiveTree().focusKey) clearHighlight(); });
  card.addEventListener("click", (e) => {
    e.stopPropagation();
    const tree = getActiveTree();
    if (tree.focusKey === node.key) clearFocus();   // erneuter Klick -> alles zeigen
    else focusSubtree(node);                          // Klasse + alle Nachkommen isolieren
  });
  return card;
}

function drawEdge(parent, child) {
  const x1 = parent.x + CARD_WIDTH / 2, y1 = parent.y + parent.h;
  const x2 = child.x + CARD_WIDTH / 2, y2 = child.y;
  const midY = (y1 + y2) / 2;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`);
  path.setAttribute("class", "edge");
  el.edges.appendChild(path);
  return path;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ============================================================
   Highlighting
   ============================================================ */
function highlight(node) {
  const tree = getActiveTree();
  el.canvas.classList.add("has-selection");
  el.edges.classList.add("has-selection");
  const related = new Set([node.key]);
  node.prereqs.forEach(p => related.add(p.key));
  node.children.forEach(c => related.add(c.key));
  for (const n of tree.nodes) {
    n.el.classList.toggle("hl", related.has(n.key));
    n.el.classList.toggle("focus", n.key === node.key);
  }
  el.edges.querySelectorAll(".edge").forEach(p => p.classList.remove("hl"));
  (node._edges || []).forEach(p => p.classList.add("hl"));
}
function clearHighlight() {
  el.canvas.classList.remove("has-selection");
  el.edges.classList.remove("has-selection");
  el.nodes.querySelectorAll(".card").forEach(c => c.classList.remove("hl", "focus"));
  el.edges.querySelectorAll(".edge").forEach(p => p.classList.remove("hl"));
}

/* Subtree-Fokus: blendet alles aus außer der Klasse und ihrer gesamten
   Nachkommenschaft (Kinder, Enkel … über alle Tiers). */
function descendantSet(node) {
  const set = new Set();
  (function dfs(n) {
    if (set.has(n.key)) return;       // schützt vor evtl. Zyklen
    set.add(n.key);
    n.children.forEach(dfs);
  })(node);
  return set;
}
function focusSubtree(node) {
  const tree = getActiveTree();
  tree.focusKey = node.key;
  const set = descendantSet(node);
  clearHighlight();
  el.canvas.classList.add("subtree-mode");
  el.edges.classList.add("subtree-mode");
  for (const n of tree.nodes) {
    n.el.classList.toggle("subtree-hidden", !set.has(n.key));
    n.el.classList.toggle("focus", n.key === node.key);
  }
  for (const e of (tree._edgeList || [])) {
    // Kante nur zeigen, wenn beide Endpunkte sichtbar sind
    e.path.classList.toggle("subtree-hidden", !(set.has(e.from) && set.has(e.to)));
  }
}
function clearFocus() {
  const tree = getActiveTree();
  if (tree) tree.focusKey = null;
  el.canvas.classList.remove("subtree-mode");
  el.edges.classList.remove("subtree-mode");
  el.nodes.querySelectorAll(".card").forEach(c => c.classList.remove("subtree-hidden", "focus", "hl"));
  el.edges.querySelectorAll(".edge").forEach(p => p.classList.remove("subtree-hidden", "hl"));
}

/* ============================================================
   View: Zoom & Pan (pro Baum)
   ============================================================ */
function applyView() {
  const v = getActiveTree().view;
  el.canvas.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`;
}
function setZoom(scale, cx, cy) {
  const v = getActiveTree().view;
  scale = Math.min(3, Math.max(0.15, scale));
  const rect = el.viewport.getBoundingClientRect();
  cx = cx ?? rect.width / 2; cy = cy ?? rect.height / 2;
  const wx = (cx - v.tx) / v.scale, wy = (cy - v.ty) / v.scale;
  v.scale = scale; v.tx = cx - wx * scale; v.ty = cy - wy * scale;
  applyView();
}
function resetView() {
  const tree = getActiveTree();
  if (!tree || tree.nodes.length === 0) return;
  const rect = el.viewport.getBoundingClientRect();
  const cw = el.canvas.offsetWidth, ch = el.canvas.offsetHeight;
  const scale = Math.min(1, (rect.width - 40) / cw, (rect.height - 40) / ch);
  tree.view.scale = Math.max(0.15, scale);
  tree.view.tx = (rect.width - cw * tree.view.scale) / 2;
  tree.view.ty = 20;
  tree.view.initialized = true;
  applyView();
}
function initPanZoom() {
  let panning = false, sx = 0, sy = 0, stx = 0, sty = 0;
  el.viewport.addEventListener("mousedown", (e) => {
    if (e.target.closest(".card")) return;
    panning = true; el.viewport.classList.add("panning");
    sx = e.clientX; sy = e.clientY;
    const v = getActiveTree().view; stx = v.tx; sty = v.ty;
  });
  window.addEventListener("mousemove", (e) => {
    if (!panning) return;
    const v = getActiveTree().view;
    v.tx = stx + (e.clientX - sx); v.ty = sty + (e.clientY - sy);
    applyView();
  });
  window.addEventListener("mouseup", () => { panning = false; el.viewport.classList.remove("panning"); });
  el.viewport.addEventListener("click", (e) => {
    if (e.target.closest(".card")) return;
    const tree = getActiveTree();
    if (tree && tree.focusKey) clearFocus();   // Klick ins Leere -> Fokus aufheben
  });
  el.viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = el.viewport.getBoundingClientRect();
    const v = getActiveTree().view;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setZoom(v.scale * factor, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
}

/* ============================================================
   Daten laden (Google Sheets / lokale Datei)
   ============================================================ */
/* Baut die CSV-URL für eine GID aus einer flexiblen Referenz:
   - "Im Web veröffentlichen"-URL .../d/e/{TOKEN}/pub  -> pub-Format
   - roher Publish-Token (beginnt mit 2PACX)           -> pub-Format
   - normale Sheet-URL .../d/{ID}/... oder bare ID      -> export-Format */
function buildCsvUrl(ref, gid) {
  ref = (ref || "").trim();
  let m = ref.match(/\/d\/e\/([^\/?#]+)/);
  if (m) return `https://docs.google.com/spreadsheets/d/e/${m[1]}/pub?output=csv&single=true&gid=${encodeURIComponent(gid)}`;
  if (/^2PACX/i.test(ref)) return `https://docs.google.com/spreadsheets/d/e/${ref}/pub?output=csv&single=true&gid=${encodeURIComponent(gid)}`;
  m = ref.match(/\/d\/([^\/?#]+)/);
  const id = m ? m[1] : ref;
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}

async function loadTreeFromSheet(tree) {
  tree.loading = true; tree.error = null;
  renderTabs();
  if (tree.name === state.activeName) showOverlay({ loading: true, msg: `Lade „${tree.name}“ aus Google Sheets…` });
  try {
    if (!state.settings.sheetRef) throw new Error("Keine Sheet-URL/ID konfiguriert. Öffne ⚙ Einstellungen.");
    if (!tree.gids || !tree.gids.length) throw new Error("Keine Tab-GIDs für diesen Baum konfiguriert.");

    // Tabs parallel laden
    const texts = await Promise.all(tree.gids.map(async (gid) => {
      const url = buildCsvUrl(state.settings.sheetRef, gid);
      // Hinweis: Der CSV-Export öffentlich veröffentlichter Sheets sendet
      // CORS-Header und ist daher per fetch() abrufbar. Bei CORS-Fehlern
      // bleibt der lokale CSV-Upload als zuverlässiger Fallback.
      const resp = await fetch(url, { redirect: "follow" });
      if (!resp.ok) throw new Error(`Tab gid=${gid}: HTTP ${resp.status}. Prüfe URL/GID und ob das Sheet „Im Web veröffentlicht“ ist.`);
      const text = await resp.text();
      if (/^\s*<(!doctype|html)/i.test(text))
        throw new Error(`Tab gid=${gid}: Antwort war HTML statt CSV.\nIst das Sheet „Im Web veröffentlichen“ freigegeben?`);
      return { gid, text };
    }));

    const parts = [];
    for (const { gid, text } of texts) parts.push(...parseSheetToClasses(text, gid));

    const { nodes, byKey, warnings } = buildTreeFromParts(parts);
    tree.nodes = nodes; tree.byKey = byKey; tree.warnings = warnings;
    tree.error = null; tree.focusKey = null; tree.view.initialized = false;
    if (warnings.length) console.warn(`[${tree.name}]\n` + warnings.join("\n"));
  } catch (err) {
    setTreeError(tree, err);
  } finally {
    tree.loading = false;
    renderTabs();
    if (tree.name === state.activeName) renderActive();
  }
}

function applyParsed(tree) {
  const { nodes, byKey, warnings } = buildTree(tree.csvText);
  tree.nodes = nodes; tree.byKey = byKey; tree.warnings = warnings;
  tree.error = null; tree.focusKey = null; tree.view.initialized = false;
}
function setTreeError(tree, err) {
  tree.error = err.message || String(err);
  tree.nodes = [];
  console.error(`[${tree.name}]`, err);
}
function loadCsvIntoTree(tree, text, displayName) {
  tree.source = "local"; tree.csvText = text;
  if (displayName) tree.localFileName = displayName;
  try { applyParsed(tree); } catch (err) { setTreeError(tree, err); }
  renderTabs();
  if (tree.name === state.activeName) renderActive();
}

/* ============================================================
   Bäume / Tabs verwalten
   ============================================================ */
function ensureTrees() {
  const keep = {};
  for (const t of state.settings.trees) {
    const existing = state.trees[t.name];
    if (existing) { existing.gids = (t.gids || []).slice(); keep[t.name] = existing; }
    else {
      const nt = newTree(t.name);
      nt.gids = (t.gids || []).slice();
      keep[t.name] = nt;
    }
  }
  // lokal hinzugefügte Bäume (nicht in Settings) erhalten
  for (const name in state.trees) {
    if (!keep[name] && state.trees[name].source === "local") keep[name] = state.trees[name];
  }
  state.trees = keep;
  if (!state.activeName || !state.trees[state.activeName]) {
    state.activeName = Object.keys(state.trees)[0] || null;
  }
}
function newTree(name) {
  return {
    name, source: "sheet", gids: [],
    csvText: "", nodes: [], byKey: {}, warnings: [],
    error: null, loading: false,
    view: { scale: 1, tx: 0, ty: 0, initialized: false },
    focusKey: null,
  };
}
function getActiveTree() { return state.activeName ? state.trees[state.activeName] : null; }

function renderTabs() {
  el.treeTabs.innerHTML = "";
  for (const name of Object.keys(state.trees)) {
    const tree = state.trees[name];
    const tab = document.createElement("div");
    tab.className = "tree-tab" + (name === state.activeName ? " active" : "");
    let status = "";
    if (tree.loading) status = "⏳";
    else if (tree.error) status = "⚠";
    else if (tree.nodes.length) status = `· ${tree.nodes.length}`;
    if (tree.source === "local") status += " 📄";
    tab.innerHTML = `${esc(name)}<span class="tab-status">${status}</span>`;
    tab.addEventListener("click", () => switchTree(name));
    el.treeTabs.appendChild(tab);
  }
}
function switchTree(name) {
  state.activeName = name;
  renderTabs();
  const tree = state.trees[name];
  if (tree && tree.source === "sheet" && state.settings.sheetRef &&
      !tree.nodes.length && !tree.error && !tree.loading) loadTreeFromSheet(tree);
  else renderActive();
}

function renderActive() {
  const tree = getActiveTree();
  el.searchInput.value = "";
  if (!tree) {
    el.nodes.innerHTML = ""; el.edges.innerHTML = "";
    showOverlay({ msg: "Keine Bäume konfiguriert.\nÖffne ⚙ Einstellungen oder lade eine lokale CSV.",
      actions: [{ label: "⚙ Einstellungen", fn: openSettings }, { label: "Lokale CSV laden", fn: () => el.fileInput.click() }] });
    return;
  }
  if (tree.source === "sheet" && !state.settings.sheetRef) { showUrlPrompt(); return; }
  if (tree.loading) { showOverlay({ loading: true, msg: `Lade „${tree.name}“…` }); return; }
  if (tree.error) {
    showOverlay({ error: true, msg: `Fehler beim Laden von „${tree.name}“:\n\n${tree.error}`,
      actions: [
        { label: "↻ Erneut versuchen", fn: () => loadTreeFromSheet(tree) },
        { label: "Lokale CSV laden", fn: () => el.fileInput.click() },
        { label: "⚙ Einstellungen", fn: openSettings },
      ] });
    return;
  }
  if (!tree.nodes.length) {
    showOverlay({ msg: `„${tree.name}“ enthält noch keine Daten.`,
      actions: [
        { label: "↻ Aus Sheet laden", fn: () => loadTreeFromSheet(tree) },
        { label: "Lokale CSV laden", fn: () => el.fileInput.click() },
      ] });
    return;
  }
  hideOverlay();
  layoutAndRender(tree);
  if (!tree.view.initialized) resetView(); else applyView();
  // Subtree-Fokus nach Neu-Rendern wiederherstellen (Karten sind neu erzeugt)
  if (tree.focusKey) {
    const fn = tree.byKey[tree.focusKey];
    if (fn) focusSubtree(fn); else tree.focusKey = null;
  }
}

/* ============================================================
   Overlay
   ============================================================ */
function showOverlay({ loading = false, error = false, msg = "", actions = [] } = {}) {
  el.overlay.classList.remove("hidden");
  el.overlaySpinner.classList.toggle("hidden", !loading);
  el.overlayMsg.textContent = msg;
  el.overlayMsg.classList.toggle("error", error);
  el.overlayActions.innerHTML = "";
  for (const a of actions) {
    const b = document.createElement("button");
    b.className = "btn"; b.textContent = a.label;
    b.addEventListener("click", a.fn);
    el.overlayActions.appendChild(b);
  }
}
function hideOverlay() { el.overlay.classList.add("hidden"); }

/* Eingabe-Prompt für den Sheet-Link direkt auf der Seite (wird nur in
   localStorage gespeichert, nicht ins Repo committet). */
function showUrlPrompt() {
  el.overlay.classList.remove("hidden");
  el.overlaySpinner.classList.add("hidden");
  el.overlayMsg.classList.remove("error");
  el.overlayMsg.textContent =
    "Google-Sheet-Link einfügen\n" +
    "(„Im Web veröffentlichen“-CSV-URL …/d/e/…/pub  oder  Spreadsheet-ID).\n" +
    "Wird nur lokal in deinem Browser gespeichert.";
  el.overlayActions.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.style.cssText = "flex-basis:100%;display:flex;justify-content:center;margin-bottom:.4rem";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "https://docs.google.com/…/pub?output=csv";
  input.style.cssText = "width:26rem;max-width:80vw";
  input.value = state.settings.sheetRef || "";
  wrap.appendChild(input);

  const load = document.createElement("button");
  load.className = "btn btn-primary"; load.textContent = "Laden";
  const settingsBtn = document.createElement("button");
  settingsBtn.className = "btn"; settingsBtn.textContent = "⚙ Mehr Einstellungen";
  const localBtn = document.createElement("button");
  localBtn.className = "btn"; localBtn.textContent = "Lokale CSV";

  const submit = () => {
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    state.settings.sheetRef = v;
    persistSettings();
    const t = getActiveTree();
    if (t && t.source === "sheet") loadTreeFromSheet(t); else renderActive();
  };
  load.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  settingsBtn.addEventListener("click", openSettings);
  localBtn.addEventListener("click", () => el.fileInput.click());

  el.overlayActions.append(wrap, load, settingsBtn, localBtn);
  setTimeout(() => input.focus(), 0);
}

/* ============================================================
   Suche
   ============================================================ */
function runSearch(query) {
  const tree = getActiveTree();
  if (!tree) return;
  el.nodes.querySelectorAll(".card").forEach(c => c.classList.remove("search-hit"));
  query = query.trim().toLowerCase();
  if (!query) return;
  const hit = tree.nodes.find(n => n.name.toLowerCase().includes(query));
  if (!hit) return;
  if (tree.focusKey) clearFocus();   // ggf. Subtree-Fokus aufheben, damit der Treffer sichtbar ist
  hit.el.classList.add("search-hit");
  centerOnNode(hit);
  highlight(hit);
}
function centerOnNode(node) {
  const v = getActiveTree().view;
  const rect = el.viewport.getBoundingClientRect();
  const nx = node.x + CARD_WIDTH / 2, ny = node.y + node.h / 2;
  v.tx = rect.width / 2 - nx * v.scale;
  v.ty = rect.height / 2 - ny * v.scale;
  applyView();
}

/* ============================================================
   Settings-Panel
   ============================================================ */
function openSettings() {
  el.sheetRefInput.value = state.settings.sheetRef || "";
  renderTreeRows();
  el.settingsPanel.classList.remove("hidden");
}
function closeSettings() { el.settingsPanel.classList.add("hidden"); }

function renderTreeRows() {
  el.treeListEl.innerHTML = "";
  const trees = state.settings.trees.length ? state.settings.trees : [{ name: "", gids: [] }];
  trees.forEach(t => el.treeListEl.appendChild(treeRow(t)));
}
function treeRow(t) {
  const row = document.createElement("div");
  row.className = "char-row tree-row";
  row.innerHTML = `
    <input class="tree-name" type="text" placeholder="Baum-Name (z.B. Klassenbaum)" value="${escAttr(t.name || "")}" />
    <input class="tree-gids" type="text" placeholder="Tab-GIDs, kommagetrennt" value="${escAttr((t.gids || []).join(", "))}" />
    <button class="btn char-del" title="Entfernen">✕</button>`;
  row.querySelector(".char-del").addEventListener("click", () => row.remove());
  return row;
}
function readTreeRows() {
  const out = [];
  el.treeListEl.querySelectorAll(".tree-row").forEach(row => {
    const name = row.querySelector(".tree-name").value.trim();
    const gids = splitList(row.querySelector(".tree-gids").value);
    if (name) out.push({ name, gids });
  });
  return out;
}
function saveSettings() {
  state.settings.sheetRef = el.sheetRefInput.value.trim();
  state.settings.trees = readTreeRows();
  persistSettings();
  ensureTrees();
  renderTabs();
  closeSettings();
  const tree = getActiveTree();
  if (tree && tree.source === "sheet") loadTreeFromSheet(tree); else renderActive();
}
function persistSettings() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state.settings)); }
  catch (e) { console.warn("localStorage nicht verfügbar:", e); }
}
function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      state.settings.sheetRef = p.sheetRef || "";
      state.settings.trees = Array.isArray(p.trees) ? p.trees : [];
      return;
    }
  } catch (e) { console.warn("Konnte Settings nicht laden:", e); }
  // Vorbelegung beim allerersten Start
  state.settings.sheetRef = DEFAULT_SETTINGS.sheetRef;
  state.settings.trees = DEFAULT_SETTINGS.trees.map(t => ({ name: t.name, gids: t.gids.slice() }));
}
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");

/* ============================================================
   Export (PNG / SVG) – eigenständige native SVG-Repräsentation
   ============================================================ */
function buildExportSvg(tree) {
  const W = el.canvas.offsetWidth, H = el.canvas.offsetHeight;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("xmlns", NS);
  svg.setAttribute("width", W); svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", W); bg.setAttribute("height", H); bg.setAttribute("fill", "#14121a");
  svg.appendChild(bg);

  for (const node of tree.nodes) {
    for (const parent of node.prereqs) {
      const x1 = parent.x + CARD_WIDTH / 2, y1 = parent.y + parent.h;
      const x2 = node.x + CARD_WIDTH / 2, y2 = node.y, midY = (y1 + y2) / 2;
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`);
      p.setAttribute("fill", "none"); p.setAttribute("stroke", "#4a4357"); p.setAttribute("stroke-width", "2");
      svg.appendChild(p);
    }
  }
  for (const node of tree.nodes) {
    const g = document.createElementNS(NS, "g");
    const border = node.isMixed ? "#b5564a" : node.isRoot ? "#4a7a55" : "#3a3346";
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", node.x); rect.setAttribute("y", node.y);
    rect.setAttribute("width", CARD_WIDTH); rect.setAttribute("height", node.h);
    rect.setAttribute("rx", "10"); rect.setAttribute("fill", "#1f1b29");
    rect.setAttribute("stroke", border); rect.setAttribute("stroke-width", "2");
    g.appendChild(rect);
    let ty = node.y + 22;
    const titleColor = node.isMixed ? "#e6938a" : node.isRoot ? "#9fd8ab" : "#e8e4f0";
    g.appendChild(svgText(NS, node.x + 12, ty, `${node.name}  (T${node.tier})`, titleColor, 15, "bold"));
    ty += 20;
    const lines = [];
    if (node.weapons.length) lines.push(["Waffe: " + node.weapons.join(", "), "#9c95ad"]);
    if (node.armor.length)   lines.push(["Rüstung: " + node.armor.join(", "), "#9c95ad"]);
    if (node.passive)        lines.push(["Passiv: " + node.passive, "#cdbf9a"]);
    if (node.active)         lines.push(["Aktiv: " + node.active, "#aab6ee"]);
    for (const [txt, color] of lines) {
      g.appendChild(svgText(NS, node.x + 12, ty, txt, color, 12, "normal", CARD_WIDTH - 24));
      ty += 16;
    }
    svg.appendChild(g);
  }
  return svg;
}
function svgText(NS, x, y, text, fill, size, weight, maxW) {
  const t = document.createElementNS(NS, "text");
  t.setAttribute("x", x); t.setAttribute("y", y); t.setAttribute("fill", fill);
  t.setAttribute("font-size", size); t.setAttribute("font-weight", weight);
  t.setAttribute("font-family", "Segoe UI, system-ui, sans-serif");
  if (maxW) {
    const maxChars = Math.floor(maxW / (size * 0.55));
    if (text.length > maxChars) text = text.slice(0, maxChars - 1) + "…";
  }
  t.textContent = text;
  return t;
}
function exportSvg() {
  const tree = getActiveTree();
  if (!tree || !tree.nodes.length) return;
  const data = new XMLSerializer().serializeToString(buildExportSvg(tree));
  downloadBlob(new Blob([data], { type: "image/svg+xml" }), `${tree.name}.svg`);
}
function exportPng() {
  const tree = getActiveTree();
  if (!tree || !tree.nodes.length) return;
  const W = el.canvas.offsetWidth, H = el.canvas.offsetHeight;
  const data = new XMLSerializer().serializeToString(buildExportSvg(tree));
  const url = URL.createObjectURL(new Blob([data], { type: "image/svg+xml" }));
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = W * scale; canvas.height = H * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale); ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    canvas.toBlob(b => downloadBlob(b, `${tree.name}.png`), "image/png");
  };
  img.onerror = () => { URL.revokeObjectURL(url); alert("PNG-Export fehlgeschlagen."); };
  img.src = url;
}
function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ============================================================
   Lokaler Datei-Upload + Drag & Drop
   ============================================================ */
function handleFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const baseName = file.name.replace(/\.csv$/i, "") || "Lokale CSV";
    // Immer einen eigenen lokalen Baum anlegen (überschreibt keinen Sheet-Baum)
    let name = baseName, i = 2;
    while (state.trees[name] && state.trees[name].source !== "local") name = `${baseName} (${i++})`;
    let tree = state.trees[name] && state.trees[name].source === "local" ? state.trees[name] : newTree(name);
    tree.source = "local";
    state.trees[name] = tree;
    state.activeName = name;
    loadCsvIntoTree(tree, reader.result, file.name);
    closeSettings();
  };
  reader.onerror = () => alert("Datei konnte nicht gelesen werden.");
  reader.readAsText(file, "utf-8");
}
function initDragDrop() {
  let depth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault(); depth++; el.dropHint.classList.remove("hidden");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", (e) => {
    e.preventDefault(); depth--; if (depth <= 0) { depth = 0; el.dropHint.classList.add("hidden"); }
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault(); depth = 0; el.dropHint.classList.add("hidden");
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
}

/* ============================================================
   Init
   ============================================================ */
function init() {
  loadSettings();
  ensureTrees();
  renderTabs();
  initPanZoom();
  initDragDrop();

  document.getElementById("settingsBtn").addEventListener("click", openSettings);
  document.getElementById("settingsCloseBtn").addEventListener("click", closeSettings);
  document.getElementById("addTreeBtn").addEventListener("click", () => {
    el.treeListEl.appendChild(treeRow({ name: "", gids: [] }));
  });
  document.getElementById("saveSettingsBtn").addEventListener("click", saveSettings);
  document.getElementById("loadLocalBtn").addEventListener("click", () => el.fileInput.click());
  el.fileInput.addEventListener("change", (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
    e.target.value = "";
  });

  document.getElementById("reloadBtn").addEventListener("click", () => {
    const tree = getActiveTree();
    if (!tree) return;
    if (tree.source === "local") { if (tree.csvText) loadCsvIntoTree(tree, tree.csvText, tree.localFileName); }
    else loadTreeFromSheet(tree);
  });
  document.getElementById("reloadAllBtn").addEventListener("click", () => {
    for (const name in state.trees) {
      const t = state.trees[name];
      if (t.source === "sheet") loadTreeFromSheet(t);
    }
  });

  document.getElementById("zoomInBtn").addEventListener("click", () => setZoom(getActiveTree().view.scale * 1.2));
  document.getElementById("zoomOutBtn").addEventListener("click", () => setZoom(getActiveTree().view.scale / 1.2));
  document.getElementById("zoomResetBtn").addEventListener("click", resetView);
  document.getElementById("exportPngBtn").addEventListener("click", exportPng);
  document.getElementById("exportSvgBtn").addEventListener("click", exportSvg);

  let searchTimer;
  el.searchInput.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value), 150);
  });
  window.addEventListener("resize", () => {
    const tree = getActiveTree();
    if (tree && tree.nodes.length && !tree.view.initialized) resetView();
  });

  const tree = getActiveTree();
  if (tree && tree.source === "sheet" && state.settings.sheetRef) loadTreeFromSheet(tree);
  else renderActive();
}
document.addEventListener("DOMContentLoaded", init);
