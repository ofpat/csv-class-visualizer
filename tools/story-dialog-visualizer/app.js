/* ============================================================
   Story-/Dialog-Visualizer — Rendering + Interaktion
   Vanilla-JS, keine Build-Tools. Stil/Mechanik nach Vorbild
   class-tree-visualizer, ABER horizontales Layout (links → rechts).

   Datenschicht (parse.js / sources.js / fixture.js / model/graph.js)
   bleibt unverändert; Quelle ist über die Adapter austauschbar
   (Vorlage jetzt, Google-Sheet später).
   ============================================================ */
(function () {
  "use strict";
  const SDV = window.SDV;
  const { tableToRecords } = SDV.parse;
  const { LocalFixtureSource, GoogleSheetSource } = SDV.sources;
  const { SCHEMA, TAB_ORDER, buildGraph } = SDV;

  /* ---------- Layout-Konstanten ---------- */
  const CARD_W = 240;       // muss zur Breite in style.css passen
  const H_GAP_X = 90;       // horizontaler Abstand zwischen Spalten (Platz für Kanten/Labels)
  const V_GAP = 26;         // vertikaler Abstand zwischen Lanes einer Spalte
  const BAND_GAP = 80;      // Abstand zwischen Kapitel-Bändern
  const PADDING = 70;

  const LS_KEY = "sdv-settings-v1";

  /* Default-GIDs der Story-Sheet-Tabs (Komfort-Vorbelegung, wie beim Klassen-Tool).
     Reine Tab-Nummern — ohne den Sheet-Token wertlos, dürfen daher im Code stehen.
     Die Sheet-URL/ID wird NICHT hartcodiert (nur localStorage), damit die Adresse
     nicht ins Repo kommt. */
  const DEFAULT_GIDS = {
    characters:    "2077677492",
    timelines:     "140359793",
    lines:         "1040180612",
    choices:       "224318331",
    combat_events: "975175058",
    chapters_meta: "1012100174",
    chapters:      "1592522402",
  };

  const TYPE_ICON = { dialog: "💬", battle: "⚔️", branch: "🔀", end: "🏁" };

  /* ---------- Zustand ---------- */
  const state = {
    graph: null,
    out: {}, inc: {},                       // Adjazenz über ALLE Kanten (für Lineage)
    pinned: null,                            // per Klick fixierter Node-Key
    filters: { chapters: new Set(), types: new Set() },
    view: { scale: 1, tx: 0, ty: 0, initialized: false },
    settings: loadSettings(),
  };

  /* ---------- DOM ---------- */
  const el = {
    stage:        document.getElementById("stage"),
    filterSidebar: document.getElementById("filterSidebar"),
    filterContent: document.getElementById("filterContent"),
    viewport:     document.getElementById("viewport"),
    canvas:       document.getElementById("canvas"),
    edges:        document.getElementById("edges"),
    labels:       document.getElementById("labels"),
    nodes:        document.getElementById("nodes"),
    overlay:      document.getElementById("overlay"),
    overlaySpinner: document.getElementById("overlaySpinner"),
    overlayMsg:   document.getElementById("overlayMsg"),
    overlayActions: document.getElementById("overlayActions"),
    drillPanel:   document.getElementById("drillPanel"),
    drillTitle:   document.getElementById("drillTitle"),
    drillBody:    document.getElementById("drillBody"),
    drillCloseBtn: document.getElementById("drillCloseBtn"),
    sourceBadge:  document.getElementById("sourceBadge"),
    reloadBtn:    document.getElementById("reloadBtn"),
    settingsBtn:  document.getElementById("settingsBtn"),
    settingsPanel: document.getElementById("settingsPanel"),
    settingsCloseBtn: document.getElementById("settingsCloseBtn"),
    sheetRefInput: document.getElementById("sheetRefInput"),
    gidList:      document.getElementById("gidList"),
    saveSheetBtn: document.getElementById("saveSheetBtn"),
    useFixtureBtn: document.getElementById("useFixtureBtn"),
    zoomInBtn:    document.getElementById("zoomInBtn"),
    zoomResetBtn: document.getElementById("zoomResetBtn"),
    zoomOutBtn:   document.getElementById("zoomOutBtn"),
  };

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const nodeById = (id) => state.graph && state.graph._byId[id];

  /* ============================================================
     Daten laden (Quelle austauschbar)
     ============================================================ */
  // GIDs aus den Settings, fehlende durch die Defaults aufgefüllt.
  function effectiveGids() { return Object.assign({}, DEFAULT_GIDS, state.settings.gids || {}); }

  function activeSource() {
    const s = state.settings;
    const gids = effectiveGids();
    // Sobald eine Sheet-URL/ID gesetzt ist und alle Tabs eine GID haben -> live.
    if (s.sheetRef && TAB_ORDER.every(t => gids[t]))
      return GoogleSheetSource(s.sheetRef, gids);
    return LocalFixtureSource();
  }

  async function loadGraph(source) {
    const tables = await source.fetchTabs(TAB_ORDER);
    const records = {};
    for (const tab of TAB_ORDER) records[tab] = tableToRecords(tables[tab], SCHEMA[tab], tab);
    const g = buildGraph(records);
    g._byId = {};
    for (const n of g.nodes) g._byId[n.id] = n;
    return g;
  }

  async function reload() {
    const source = activeSource();
    el.sourceBadge.textContent = source.kind === "google-sheet" ? "⚡ Sheet" : "📄 Vorlage";
    showOverlay({ loading: true, msg: `Lade aus ${source.label}…` });
    try {
      const g = await loadGraph(source);
      state.graph = g;
      buildAdjacency(g);
      window.SDV.lastGraph = g;
      hideOverlay();
      render();
      if (g.issues.length) console.warn("[SDV] Diagnose:", g.issues);
      if (g.warnings.length) console.warn("[SDV] Warnungen:", g.warnings);
    } catch (err) {
      console.error(err);
      showOverlay({ error: true, msg: "Fehler beim Laden:\n\n" + (err && err.message || err),
        actions: [
          { label: "↻ Erneut", fn: reload },
          { label: "📄 Vorlage verwenden", fn: () => { clearSheetSettings(); reload(); } },
          { label: "⚙ Einstellungen", fn: openSettings },
        ] });
    }
  }

  function buildAdjacency(g) {
    state.out = {}; state.inc = {};
    for (const n of g.nodes) { state.out[n.id] = []; state.inc[n.id] = []; }
    for (const e of g.edges) {
      if (state.out[e.from]) state.out[e.from].push(e.to);
      if (state.inc[e.to]) state.inc[e.to].push(e.from);
    }
  }

  /* ============================================================
     Layout: horizontal (L→R). Spalte = Fluss-Tiefe (longest path über
     Struktur-Kanten), Lane = vertikale Position (Branches fächern auf).
     Kapitel werden als gestapelte Bänder angeordnet; Flag-Kanten
     überbrücken die Bänder.
     ============================================================ */
  function computeLayout(g) {
    const struct = g.edges.filter(e => e.kind !== "flag");

    // Tiefe (Spalte) via Längster-Pfad-Relaxation
    const depth = {};
    for (const n of g.nodes) depth[n.id] = 0;
    for (let i = 0; i < g.nodes.length; i++) {
      let changed = false;
      for (const e of struct) if (depth[e.to] < depth[e.from] + 1) { depth[e.to] = depth[e.from] + 1; changed = true; }
      if (!changed) break;
    }

    // Lane-Hinweis: Branch true → nach oben, false → nach unten; sonst erben.
    const lane = {};
    const entries = new Set(g.chapters.map(c => c.entryStep));
    for (const n of g.nodes) if (entries.has(n.id)) lane[n.id] = 0;
    const maxDepth = Math.max(0, ...Object.values(depth));
    for (let d = 0; d <= maxDepth; d++) {
      for (const e of struct) {
        if (depth[e.from] !== d) continue;
        const base = lane[e.from] || 0;
        let l = base;
        if (e.kind === "branch-true") l = base - 1;
        else if (e.kind === "branch-false") l = base + 1;
        lane[e.to] = (lane[e.to] === undefined) ? l : (lane[e.to] + l) / 2;
      }
    }

    // x je Spalte (kapitelübergreifend ausgerichtet)
    const colX = (d) => PADDING + d * (CARD_W + H_GAP_X);

    // Bänder je Kapitel vertikal stapeln
    let bandTop = PADDING;
    let totalW = 0;
    for (const c of g.chapters) {
      const chNodes = c.steps.map(id => g._byId[id]).filter(Boolean);
      const cols = {};
      for (const n of chNodes) (cols[depth[n.id]] = cols[depth[n.id]] || []).push(n);
      const colKeys = Object.keys(cols).map(Number).sort((a, b) => a - b);

      let bandH = 0;
      for (const d of colKeys) {
        const k = cols[d].length;
        const h = cols[d].reduce((s, n) => s + n.h, 0) + (k - 1) * V_GAP;
        bandH = Math.max(bandH, h);
      }
      for (const d of colKeys) {
        const colNodes = cols[d].slice().sort((a, b) => (lane[a.id] - lane[b.id]) || a.order - b.order);
        const k = colNodes.length;
        const colH = colNodes.reduce((s, n) => s + n.h, 0) + (k - 1) * V_GAP;
        let y = bandTop + (bandH - colH) / 2;
        for (const n of colNodes) {
          n.x = colX(d); n.y = y;
          n.el.style.left = n.x + "px";
          n.el.style.top = n.y + "px";
          y += n.h + V_GAP;
        }
        totalW = Math.max(totalW, colX(d) + CARD_W);
      }
      c._bandTop = bandTop; c._bandH = bandH;
      bandTop += bandH + BAND_GAP;
    }

    const totalWidth = totalW + PADDING;
    const totalHeight = bandTop - BAND_GAP + PADDING;
    el.edges.setAttribute("width", totalWidth);
    el.edges.setAttribute("height", totalHeight);
    for (const node of [el.edges, el.canvas, el.labels])
      { node.style.width = totalWidth + "px"; node.style.height = totalHeight + "px"; }
  }

  /* ============================================================
     Rendering
     ============================================================ */
  function render() {
    const g = state.graph;
    el.nodes.innerHTML = ""; el.edges.innerHTML = ""; el.labels.innerHTML = "";
    if (!g || !g.nodes.length) { showOverlay({ msg: "Keine Daten." }); return; }

    for (const n of g.nodes) { n.el = createCard(n); el.nodes.appendChild(n.el); }
    for (const n of g.nodes) n.h = n.el.offsetHeight;

    computeLayout(g);
    drawEdges(g);

    renderFilterSidebar(g);
    applyFilter();
    if (!state.view.initialized) resetView(); else applyView();
    // bestehende Auswahl nach Re-Render wiederherstellen
    if (state.pinned && g._byId[state.pinned]) selectNode(g._byId[state.pinned], true);
  }

  function createCard(n) {
    const card = document.createElement("div");
    const dead = n.diagnostics.some(d => d.severity === "dead-end");
    const term = n.diagnostics.some(d => d.severity === "terminal-chapter");
    card.className = `node type-${n.type}` + (dead ? " dead-end" : "") + (term ? " terminal" : "");
    card.dataset.id = n.id;

    const badges = [];
    if (n.isEntry) badges.push(`<span class="badge entry" title="Kapitel-Eintritt${n.entryGate ? `: ${esc(n.entryGate.flag)}=${esc(n.entryGate.value)}` : ""}">⮞ Eintritt</span>`);
    if (dead) badges.push(`<span class="badge dead" title="${esc(n.diagnostics.find(d=>d.severity==='dead-end').message)}">🔴 Sackgasse</span>`);
    else if (term) badges.push(`<span class="badge term" title="${esc(n.diagnostics.find(d=>d.severity==='terminal-chapter').message)}">🟠 Endpunkt</span>`);

    const rows = [];
    rows.push(`<div class="node-head">
        <span class="node-icon">${TYPE_ICON[n.type] || "•"}</span>
        <span class="node-id">${esc(n.id)}</span>
        <span class="node-type">${esc(n.type)}</span>
      </div>`);
    rows.push(`<div class="node-title">${esc(n.title)}</div>`);
    if (badges.length) rows.push(`<div class="node-badges">${badges.join("")}</div>`);

    if (n.type === "branch")
      rows.push(`<div class="node-row"><span class="lbl">prüft</span> ${esc(n.branch.flag)} == ${esc(n.branch.value)}</div>`);
    if (n.type === "battle" && n.battle_events.length)
      rows.push(`<div class="node-row"><span class="lbl">Events</span> ${esc(n.battle_events.join(", "))}</div>`);

    if (n.writesFlags.length)
      rows.push(`<div class="node-row flags-write"><span class="lbl">⚑ setzt</span> ${esc(n.writesFlags.map(f => `${f.flag}=${f.value}`).join(", "))}</div>`);
    if (n.readsFlags.length)
      rows.push(`<div class="node-row flags-read"><span class="lbl">↳ liest</span> ${esc(n.readsFlags.map(f => f.flag).join(", "))}</div>`);

    const drillable = n.type === "dialog" || n.type === "battle";
    if (drillable) rows.push(`<div class="node-drill-hint">${n.type === "dialog" ? "💬 Dialog ansehen" : "⚔️ Kampf ansehen"} ›</div>`);

    card.innerHTML = rows.join("");

    card.addEventListener("mouseenter", () => { if (!state.pinned) highlightLineage(n.id); });
    card.addEventListener("mouseleave", () => { if (!state.pinned) clearHighlight(); });
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.pinned === n.id) { clearSelection(); }
      else selectNode(n);
    });
    return card;
  }

  function drawEdges(g) {
    g._edgeEls = [];
    const SVGNS = "http://www.w3.org/2000/svg";
    for (const e of g.edges) {
      const a = g._byId[e.from], b = g._byId[e.to];
      if (!a || !b) continue;
      const path = document.createElementNS(SVGNS, "path");
      const isFlag = e.kind === "flag";
      let d;
      if (isFlag) {
        // Brücke: von Unterkante Quelle zu Oberkante Ziel, weit gebogen.
        const sx = a.x + CARD_W / 2, sy = a.y + a.h;
        const ex = b.x + CARD_W / 2, ey = b.y;
        const dy = Math.max(50, Math.abs(ey - sy) / 2);
        d = `M ${sx} ${sy} C ${sx} ${sy + dy}, ${ex} ${ey - dy}, ${ex} ${ey}`;
      } else {
        // Ablauf/Branch: L→R, horizontale Tangenten.
        const sx = a.x + CARD_W, sy = a.y + a.h / 2;
        const ex = b.x, ey = b.y + b.h / 2;
        const dx = Math.max(30, (ex - sx) / 2);
        d = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`;
      }
      path.setAttribute("d", d);
      path.setAttribute("class", "edge edge-" + e.kind + (e.scope ? " scope-" + e.scope : ""));
      el.edges.appendChild(path);

      let labelEl = null;
      const labelText = isFlag ? e.label : (e.kind === "branch-true" ? "true" : e.kind === "branch-false" ? "false" : "");
      if (labelText) {
        labelEl = document.createElement("div");
        labelEl.className = "edge-label" + (isFlag ? " flag" : " branch");
        labelEl.textContent = labelText;
        // grob am Pfad-Mittelpunkt
        const mx = isFlag ? (a.x + CARD_W / 2 + b.x + CARD_W / 2) / 2 : (a.x + CARD_W + b.x) / 2;
        const my = isFlag ? (a.y + a.h + b.y) / 2 : (a.y + a.h / 2 + b.y + b.h / 2) / 2;
        labelEl.style.left = mx + "px";
        labelEl.style.top = my + "px";
        el.labels.appendChild(labelEl);
      }
      g._edgeEls.push({ path, label: labelEl, from: e.from, to: e.to, kind: e.kind });
    }
  }

  /* ============================================================
     Highlight: kompletter Pfad (vorwärts + rückwärts, inkl. Flag-Kanten)
     ============================================================ */
  function lineageSet(id) {
    const set = new Set([id]);
    const walk = (start, adj) => {
      const stack = [start];
      while (stack.length) { const x = stack.pop(); for (const y of adj[x] || []) if (!set.has(y)) { set.add(y); stack.push(y); } }
    };
    walk(id, state.out);   // alle erreichbaren Folge-Nodes
    walk(id, state.inc);   // alle Vorgänger
    return set;
  }

  function applyHighlight(keys, focusId) {
    const g = state.graph;
    el.canvas.classList.add("has-selection");
    for (const n of g.nodes) {
      n.el.classList.toggle("hl", keys.has(n.id));
      n.el.classList.toggle("focus", n.id === focusId);
    }
    for (const e of (g._edgeEls || [])) {
      const on = keys.has(e.from) && keys.has(e.to);
      e.path.classList.toggle("hl", on);
      if (e.label) e.label.classList.toggle("hl", on);
    }
  }
  function highlightLineage(id) { applyHighlight(lineageSet(id), id); }
  function clearHighlight() {
    const g = state.graph;
    el.canvas.classList.remove("has-selection");
    if (!g) return;
    for (const n of g.nodes) n.el.classList.remove("hl", "focus");
    for (const e of (g._edgeEls || [])) { e.path.classList.remove("hl"); if (e.label) e.label.classList.remove("hl"); }
  }

  /* ---------- Auswahl (Click): Highlight fixieren + Drill-down ---------- */
  function selectNode(n, keepView) {
    state.pinned = n.id;
    highlightLineage(n.id);
    el.canvas.classList.add("pinned");
    if (n.type === "dialog" || n.type === "battle") openDrill(n);
    else closeDrill();
    if (!keepView) centerOnNode(n);
  }
  function clearSelection() {
    state.pinned = null;
    el.canvas.classList.remove("pinned");
    clearHighlight();
    closeDrill();
  }

  /* ============================================================
     Drill-down-Panel
     ============================================================ */
  function openDrill(n) {
    const dd = state.graph.drilldown[n.id];
    el.drillPanel.classList.remove("hidden");
    el.stage.classList.add("with-drill");
    el.drillTitle.innerHTML = `${TYPE_ICON[n.type]} ${esc(n.id)} — ${esc(n.title)}`;
    el.drillBody.innerHTML = dd ? (dd.kind === "dialog" ? drillDialog(dd) : drillBattle(dd)) : "<p>Keine Detaildaten.</p>";
  }
  function closeDrill() {
    el.drillPanel.classList.add("hidden");
    el.stage.classList.remove("with-drill");
  }

  function drillDialog(dd) {
    const out = [];
    if (dd.timeline) {
      const t = dd.timeline;
      out.push(`<div class="dd-meta">
        <div><span class="lbl">Hintergrund</span> ${esc(t.background || "–")}</div>
        <div><span class="lbl">Musik</span> ${esc(t.music || "–")}</div>
        ${t.notes ? `<div class="dd-note">${esc(t.notes)}</div>` : ""}
      </div>`);
    }
    out.push(`<div class="dd-section-title">Zeilen (${dd.lines.length})</div>`);
    for (const ln of dd.lines) {
      const meta = [];
      if (ln.emotion) meta.push(`<span class="chip emo">${esc(ln.emotion)}</span>`);
      if (ln.condition) meta.push(`<span class="chip cond" title="nur wenn Flag passt">if ${esc(ln.condition.flag)}=${esc(ln.condition.value)}</span>`);
      if (ln.action) meta.push(`<span class="chip act">${esc(ln.action)}</span>`);
      out.push(`<div class="dd-line">
        <div class="dd-line-head"><span class="dd-speaker">${esc(ln.speakerName)}</span>${meta.join("")}</div>
        <div class="dd-text">${esc(ln.text)}</div>
        ${ln.choiceGroup ? renderChoiceGroup(ln.choiceGroup, dd.choiceGroups[ln.choiceGroup]) : ""}
      </div>`);
    }
    return out.join("");
  }
  function renderChoiceGroup(cg, options) {
    if (!options) return "";
    const opts = options.map(o => `<li class="dd-choice">
        <span class="dd-choice-text">${esc(o.text)}</span>
        ${o.setFlag ? `<span class="chip setflag" title="schreibt Flag (Branch-Auslöser)">⚑ ${esc(o.setFlag)}=${esc(o.setValue)}</span>` : ""}
        ${o.impact ? `<span class="chip impact ${esc(o.impact)}">${esc(o.impact)}</span>` : ""}
        ${o.description ? `<div class="dd-choice-desc">${esc(o.description)}</div>` : ""}
      </li>`).join("");
    return `<div class="dd-choicegroup">
        <div class="dd-choicegroup-title">⤷ Auswahl <code>${esc(cg)}</code> — schreibt Flags (Branch-Auslöser)</div>
        <ul>${opts}</ul>
      </div>`;
  }
  function drillBattle(dd) {
    const out = [`<div class="dd-meta"><div><span class="lbl">Map</span> ${esc(dd.map || "–")}</div></div>`];
    out.push(`<div class="dd-section-title">Combat-Events (${dd.events.length})</div>`);
    if (!dd.events.length) out.push(`<p class="dd-note">Keine In-Kampf-Events.</p>`);
    for (const ev of dd.events) {
      if (ev.missing) { out.push(`<div class="dd-line"><span class="chip warn">⚠ Event "${esc(ev.id)}" nicht definiert</span></div>`); continue; }
      const eff = ev.effects.map(e => {
        const isFlag = /^set_flag:/i.test(e);
        return `<span class="chip ${isFlag ? "setflag" : "act"}">${isFlag ? "⚑ " : ""}${esc(e)}</span>`;
      }).join("");
      out.push(`<div class="dd-line">
        <div class="dd-line-head"><span class="dd-speaker">${esc(ev.id)}</span>
          <span class="chip">${esc(ev.trigger_type)}${ev.trigger_value ? "=" + esc(ev.trigger_value) : ""}</span>
          ${ev.once === "true" ? `<span class="chip">once</span>` : ""}</div>
        <div class="dd-effects">${eff}</div>
        ${ev.startsTimeline ? `<div class="dd-note">startet Timeline: <code>${esc(ev.startsTimeline)}</code></div>` : ""}
      </div>`);
    }
    return out.join("");
  }

  /* ============================================================
     Filter-Sidebar: nach Kapitel und Step-Typ, mit Anzahl
     ============================================================ */
  function renderFilterSidebar(g) {
    el.filterContent.innerHTML = "";
    const f = state.filters;

    const reset = document.createElement("button");
    reset.className = "filter-reset" + ((f.chapters.size || f.types.size) ? " active" : "");
    reset.textContent = "Alle anzeigen";
    reset.addEventListener("click", () => { f.chapters.clear(); f.types.clear(); applyFilter(); renderFilterSidebar(g); });
    el.filterContent.appendChild(reset);

    const section = (title, set, entries) => {
      const h = document.createElement("div");
      h.className = "filter-group-title"; h.textContent = title;
      el.filterContent.appendChild(h);
      for (const [id, label, count] of entries) {
        const b = document.createElement("button");
        b.className = "filter-cat" + (set.has(id) ? " active" : "");
        b.innerHTML = `<span class="filter-cat-label">${esc(label)}</span><span class="filter-cat-count">${count}</span>`;
        b.addEventListener("click", () => {
          if (set.has(id)) set.delete(id); else set.add(id);
          applyFilter(); renderFilterSidebar(g);
        });
        el.filterContent.appendChild(b);
      }
    };

    const chapCounts = g.chapters.map(c => [c.id, c.title, c.steps.length]);
    const typeCounts = {};
    for (const n of g.nodes) typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;
    const typeEntries = Object.keys(typeCounts).sort()
      .map(t => [t, `${TYPE_ICON[t] || ""} ${t}`, typeCounts[t]]);

    section("Kapitel", f.chapters, chapCounts);
    section("Step-Typ", f.types, typeEntries);

    el.stage.classList.add("with-sidebar");
    el.filterSidebar.classList.remove("hidden");
  }

  function nodeMatchesFilter(n) {
    const f = state.filters;
    if (f.chapters.size && !f.chapters.has(n.chapter)) return false;
    if (f.types.size && !f.types.has(n.type)) return false;
    return true;
  }
  function applyFilter() {
    const g = state.graph; if (!g) return;
    const active = state.filters.chapters.size || state.filters.types.size;
    el.canvas.classList.toggle("has-filter", !!active);
    const match = {};
    for (const n of g.nodes) { match[n.id] = nodeMatchesFilter(n); n.el.classList.toggle("filtered-out", active && !match[n.id]); }
    for (const e of (g._edgeEls || [])) {
      const on = !active || (match[e.from] && match[e.to]);
      e.path.classList.toggle("filtered-out", !on);
      if (e.label) e.label.classList.toggle("filtered-out", !on);
    }
  }

  /* ============================================================
     View: Zoom & Pan
     ============================================================ */
  function applyView() {
    const v = state.view;
    el.canvas.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`;
  }
  function setZoom(scale, cx, cy) {
    const v = state.view;
    scale = Math.min(2.5, Math.max(0.1, scale));
    const rect = el.viewport.getBoundingClientRect();
    cx = cx ?? rect.width / 2; cy = cy ?? rect.height / 2;
    const wx = (cx - v.tx) / v.scale, wy = (cy - v.ty) / v.scale;
    v.scale = scale; v.tx = cx - wx * scale; v.ty = cy - wy * scale;
    applyView();
  }
  function resetView() {
    const rect = el.viewport.getBoundingClientRect();
    const cw = el.canvas.offsetWidth, ch = el.canvas.offsetHeight;
    if (!cw || !ch) return;
    const scale = Math.min(1, (rect.width - 40) / cw, (rect.height - 40) / ch);
    state.view.scale = Math.max(0.1, scale);
    state.view.tx = (rect.width - cw * state.view.scale) / 2;
    state.view.ty = 20;
    state.view.initialized = true;
    applyView();
  }
  function centerOnNode(n) {
    const v = state.view;
    const rect = el.viewport.getBoundingClientRect();
    const cx = n.x + CARD_W / 2, cy = n.y + n.h / 2;
    v.tx = rect.width / 2 - cx * v.scale;
    v.ty = rect.height / 2 - cy * v.scale;
    applyView();
  }
  function initPanZoom() {
    const TH = 4;
    let panning = false, dragged = false, sx = 0, sy = 0, stx = 0, sty = 0;
    el.viewport.addEventListener("mousedown", (e) => {
      if (e.target.closest(".node")) return;
      panning = true; dragged = false; el.viewport.classList.add("panning");
      sx = e.clientX; sy = e.clientY; stx = state.view.tx; sty = state.view.ty;
    });
    window.addEventListener("mousemove", (e) => {
      if (!panning) return;
      if (Math.abs(e.clientX - sx) > TH || Math.abs(e.clientY - sy) > TH) dragged = true;
      state.view.tx = stx + (e.clientX - sx); state.view.ty = sty + (e.clientY - sy);
      applyView();
    });
    window.addEventListener("mouseup", () => { panning = false; el.viewport.classList.remove("panning"); });
    el.viewport.addEventListener("click", (e) => {
      if (e.target.closest(".node")) return;
      if (dragged) return;
      if (state.pinned) clearSelection();
    });
    el.viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = el.viewport.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setZoom(state.view.scale * factor, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
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

  /* ============================================================
     Settings (Quelle)
     ============================================================ */
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || { sheetRef: "", gids: {} }; }
    catch { return { sheetRef: "", gids: {} }; }
  }
  function saveSettings() { localStorage.setItem(LS_KEY, JSON.stringify(state.settings)); }
  function clearSheetSettings() { state.settings = { sheetRef: "", gids: {} }; saveSettings(); }

  function openSettings() {
    el.sheetRefInput.value = state.settings.sheetRef || "";
    el.gidList.innerHTML = "";
    const gids = effectiveGids();   // Defaults vorbelegen
    for (const tab of TAB_ORDER) {
      const row = document.createElement("div");
      row.className = "gid-row";
      row.innerHTML = `<span class="gid-tab">${esc(tab)}</span>`;
      const inp = document.createElement("input");
      inp.type = "text"; inp.placeholder = "gid"; inp.dataset.tab = tab;
      inp.value = gids[tab] || "";
      row.appendChild(inp);
      el.gidList.appendChild(row);
    }
    el.settingsPanel.classList.remove("hidden");
  }
  function closeSettings() { el.settingsPanel.classList.add("hidden"); }

  /* ============================================================
     Init
     ============================================================ */
  function wire() {
    el.reloadBtn.addEventListener("click", reload);
    el.settingsBtn.addEventListener("click", openSettings);
    el.settingsCloseBtn.addEventListener("click", closeSettings);
    el.drillCloseBtn.addEventListener("click", () => { if (state.pinned) clearSelection(); else closeDrill(); });
    el.zoomInBtn.addEventListener("click", () => setZoom(state.view.scale * 1.2));
    el.zoomOutBtn.addEventListener("click", () => setZoom(state.view.scale / 1.2));
    el.zoomResetBtn.addEventListener("click", resetView);
    el.useFixtureBtn.addEventListener("click", () => { clearSheetSettings(); closeSettings(); reload(); });
    el.saveSheetBtn.addEventListener("click", () => {
      state.settings.sheetRef = el.sheetRefInput.value.trim();
      state.settings.gids = {};
      el.gidList.querySelectorAll("input").forEach(i => { if (i.value.trim()) state.settings.gids[i.dataset.tab] = i.value.trim(); });
      saveSettings(); closeSettings(); reload();
    });
    initPanZoom();
    window.addEventListener("resize", () => { if (state.graph && !state.pinned) resetView(); });
  }

  // Für Konsole/Debug + Stufe-2-Wiederverwendung
  SDV.app = { loadGraph, reload, get graph() { return state.graph; } };

  document.addEventListener("DOMContentLoaded", () => { wire(); reload(); });
})();
