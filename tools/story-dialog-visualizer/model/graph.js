/* ============================================================
   Story-/Dialog-Visualizer — Graph-Datenmodell
   ============================================================
   Wandelt die geparsten Tabs in ein quellen-UNABHÄNGIGES Graph-Modell:

     Nodes  = chapter-Steps (dialog | battle | branch | end), type als Attribut.
     Edges  = (a) Ablauf innerhalb eines Kapitels: order bzw. expliziter `next`;
              (b) branch -> zwei Kanten (true/false), Label branch_flag=branch_value;
              (c) FLAG-Brücken (intra-chapter): ein flag-schreibender Step
                  (choices.set_flag | combat_events.effects | line.action set_flag)
                  wird mit einem branch/condition-Step verbunden, der es liest;
              (d) KAPITEL-VERKETTUNG "chapter" (inter-chapter): vom end-Step eines
                  Vorgängers zum ersten Step eines Folgekapitels. Der Vorgänger ist
                  das Kapitel, dessen end-Step-Flag (ref-Spalte, sonst
                  "{chapter_id}_completed") in den entry_conditions des Folgekapitels
                  steht; die übrigen Bedingungen (Diskriminatoren wie route/Pfadwahl)
                  bilden das Kanten-Label.

     end-Step setzt: ref-Spalte (falls gesetzt), sonst "{chapter_id}_completed".
     Flags mit Präfix game_over_/ending_ gelten als gewollte Enden (Terminals).

   Zusätzlich: Drill-down je Step (dialog -> timeline -> lines -> choice_group ->
   choices; battle -> map + combat_events). Das KERN-Graphmodell bleibt aber die
   Step-Ebene.

   Reines Datenmodell – KEIN Rendering.
   ============================================================ */
(function () {
  "use strict";
  const SDV = (window.SDV = window.SDV || {});
  const { norm, parseSetFlags, splitEffects } = SDV.parse;

  // Pflicht-Spalten je Tab (nur zur Header-Erkennung in tableToRecords).
  const SCHEMA = {
    characters:    ["character_id", "display_name"],
    timelines:     ["timeline_id", "title"],
    lines:         ["timeline_id", "order", "speaker"],
    choices:       ["choice_group", "option_order"],
    combat_events: ["event_id", "trigger_type"],
    chapters_meta: ["chapter_id", "title"],
    chapters:      ["chapter_id", "step_id", "type"],
  };
  const TAB_ORDER = Object.keys(SCHEMA);

  const splitIds = (v) => norm(v).split(/[;,]/).map(s => s.trim()).filter(Boolean);
  const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

  /* records: { characters:[], timelines:[], lines:[], choices:[],
     combat_events:[], chapters_meta:[], chapters:[] } (bereits getippt). */
  function buildGraph(records) {
    const warnings = [];
    const warn = (m) => warnings.push(m);

    const chars     = records.characters    || [];
    const timelines = records.timelines      || [];
    const lines     = records.lines          || [];
    const choices   = records.choices        || [];
    const combat    = records.combat_events  || [];
    const chapMeta  = records.chapters_meta  || [];
    const chapSteps = records.chapters       || [];

    /* ---------- Indizes ---------- */
    const charById = index(chars, "character_id");
    const tlById   = index(timelines, "timeline_id");
    const metaById = index(chapMeta, "chapter_id");

    // lines je timeline (nach order sortiert)
    const linesByTl = groupBy(lines, "timeline_id");
    for (const k in linesByTl) linesByTl[k].sort((a, b) => numOr(a.order, 0) - numOr(b.order, 0));

    // choices je choice_group (nach option_order)
    const choicesByGroup = groupBy(choices, "choice_group");
    for (const k in choicesByGroup) choicesByGroup[k].sort((a, b) => numOr(a.option_order, 0) - numOr(b.option_order, 0));

    // choice_group -> timeline_id (die Zeile, an der die Auswahl hängt)
    const groupToTimeline = {};
    for (const ln of lines) {
      const cg = norm(ln.choice_group);
      if (cg && !groupToTimeline[cg]) groupToTimeline[cg] = norm(ln.timeline_id);
    }

    const combatById = index(combat, "event_id");

    /* ---------- Nodes: chapter-Steps ---------- */
    const nodes = [];
    const nodeById = {};
    const stepsByChapter = {};
    for (const s of chapSteps) {
      const id = norm(s.step_id);
      if (!id) { warn(`chapters: Zeile ohne step_id übersprungen.`); continue; }
      if (nodeById[id]) { warn(`chapters: doppelte step_id "${id}" – übersprungen.`); continue; }
      const type = norm(s.type).toLowerCase();
      const node = {
        id,
        chapter: norm(s.chapter_id),
        order: numOr(s.order, 0),
        type,
        ref: norm(s.ref),
        condition_flag: norm(s.condition_flag),
        condition_value: norm(s.condition_value),
        battle_events: splitIds(s.battle_events),
        next: norm(s.next),
        branch: type === "branch"
          ? { flag: norm(s.branch_flag), value: norm(s.branch_value),
              ifTrue: norm(s.next_if_true), ifFalse: norm(s.next_if_false) }
          : null,
        notes: norm(s.notes),
        // Anzeige-Titel: dialog -> Timeline-Titel; sonst ref/typ.
        title: "",
        writesFlags: [],
        readsFlags: [],
        isEntry: false,
        entryGate: null,
        entryConditions: [],
        diagnostics: [],
        endFlag: "",
        intentionalEnd: false,
      };
      nodes.push(node);
      nodeById[id] = node;
      (stepsByChapter[node.chapter] = stepsByChapter[node.chapter] || []).push(node);
    }
    for (const ch in stepsByChapter) stepsByChapter[ch].sort((a, b) => a.order - b.order);

    // Titel ableiten
    for (const n of nodes) {
      if (n.type === "dialog") n.title = (tlById[n.ref] && tlById[n.ref].title) || n.ref;
      else if (n.type === "battle") n.title = n.ref || "Kampf";
      else if (n.type === "branch") n.title = `Verzweigung: ${n.branch.flag}`;
      else if (n.type === "end") n.title = "Kapitelende";
      else { n.title = n.ref || n.type; warn(`Step "${n.id}": unbekannter type "${n.type}".`); }
    }

    /* ---------- Kapitel-Übersicht + Eintritts-Bedingungen ---------- */
    // entry_conditions = UND-Liste "flag=value; flag2=value2". Leer = Startkapitel.
    // Rückwärtskompatibel: fehlt entry_conditions, wird das alte Paar
    // entry_flag/entry_value als EINE Bedingung gelesen (Alt-Schema).
    const chapters = [];
    let chapIdx = 0;
    for (const ch in stepsByChapter) {
      const steps = stepsByChapter[ch];
      const entry = steps[0];                       // kleinster order = Eintritt
      const meta = metaById[ch] || {};
      let conds = parseConditions(meta.entry_conditions);
      if (!conds.length && norm(meta.entry_flag))
        conds = [{ flag: norm(meta.entry_flag), value: norm(meta.entry_value) }];
      const route = norm(meta.route);
      if (entry) {
        entry.isEntry = true;
        entry.entryConditions = conds;
        if (conds.length) entry.entryGate = conds[0];   // Kompat.: 1. Bedingung
        // Eintritts-Bedingungen als "liest" am Eintritts-Step anzeigen
        for (const cond of conds) entry.readsFlags.push({ flag: cond.flag, value: cond.value, as: "chapter-entry" });
      }
      chapters.push({
        id: ch,
        title: norm(meta.title) || ch,
        route,
        _idx: chapIdx++,
        entryConditions: conds,
        isStart: !conds.length,
        entryStep: entry ? entry.id : null,
        steps: steps.map(s => s.id),
      });
    }
    // Optionale Gruppierung nach route: gleiche route-Kapitel werden gestapelt
    // (Lanes), Reihenfolge innerhalb einer route bleibt stabil.
    chapters.sort((a, b) => (a.route || "").localeCompare(b.route || "") || a._idx - b._idx);

    /* ---------- Ablauf-Kanten (intra-chapter) ---------- */
    const edges = [];
    const addEdge = (e) => edges.push(e);

    for (const ch in stepsByChapter) {
      const steps = stepsByChapter[ch];
      steps.forEach((s, i) => {
        if (s.type === "end") return;                 // Endknoten: keine Ausgangskante
        if (s.type === "branch") {
          const lbl = `${s.branch.flag}=${s.branch.value}`;
          if (s.branch.ifTrue) addEdge({ from: s.id, to: s.branch.ifTrue, kind: "branch-true",
            label: lbl, reason: `branch: ${s.branch.flag} == ${s.branch.value}` });
          else warn(`branch "${s.id}": next_if_true fehlt.`);
          if (s.branch.ifFalse) addEdge({ from: s.id, to: s.branch.ifFalse, kind: "branch-false",
            label: `sonst (${s.branch.flag}≠${s.branch.value})`, reason: `branch: ${s.branch.flag} != ${s.branch.value}` });
          else warn(`branch "${s.id}": next_if_false fehlt.`);
          return;
        }
        // dialog / battle: expliziter next ODER nächster nach order
        if (s.next) {
          if (nodeById[s.next]) addEdge({ from: s.id, to: s.next, kind: "next",
            label: "", reason: `expliziter next überschreibt order` });
          else warn(`Step "${s.id}": next "${s.next}" nicht gefunden.`);
        } else {
          const nxt = steps[i + 1];
          if (nxt) addEdge({ from: s.id, to: nxt.id, kind: "order",
            label: "", reason: `Reihenfolge order ${s.order} → ${nxt.order}` });
          // kein nxt: Kapitel endet ohne expliziten end-Step (nur Warnung, falls nicht end)
          else warn(`Step "${s.id}": letzter Step im Kapitel, aber type=${s.type} (kein end).`);
        }
      });
    }

    /* ---------- Flag-Schreibvorgänge sammeln ---------- */
    // Hilfsindizes: timeline -> dialog-Step, event -> battle-Step
    const dialogStepByTimeline = {};
    for (const n of nodes) if (n.type === "dialog" && n.ref) {
      if (dialogStepByTimeline[n.ref]) warn(`Timeline "${n.ref}" von mehreren dialog-Steps referenziert.`);
      else dialogStepByTimeline[n.ref] = n.id;
    }
    const battleStepByEvent = {};
    for (const n of nodes) if (n.type === "battle")
      for (const ev of n.battle_events) (battleStepByEvent[ev] = battleStepByEvent[ev] || []).push(n.id);

    const writes = []; // {flag, value, nodeId, via}
    const addWrite = (flag, value, nodeId, via) => {
      if (!flag || !nodeId) return;
      writes.push({ flag, value, nodeId, via });
      const n = nodeById[nodeId];
      if (n) n.writesFlags.push({ flag, value, via });
    };

    // (1) choices.set_flag — Host-Step = dialog-Step der Timeline der choice_group
    for (const c of choices) {
      const flag = norm(c.set_flag); if (!flag) continue;
      const cg = norm(c.choice_group);
      const tl = groupToTimeline[cg];
      const host = tl ? dialogStepByTimeline[tl] : null;
      if (!host) { warn(`choice_group "${cg}": kein dialog-Step gefunden (Timeline ${tl || "?"}).`); continue; }
      addWrite(flag, norm(c.set_value), host, `choice ${cg}#${norm(c.option_order)} (${norm(c.impact) || "?"})`);
    }
    // (2) line.action set_flag — Host-Step = dialog-Step der Timeline
    for (const ln of lines) {
      const host = dialogStepByTimeline[norm(ln.timeline_id)];
      for (const f of parseSetFlags(ln.action)) {
        if (!host) { warn(`line ${norm(ln.timeline_id)}#${norm(ln.order)}: kein dialog-Step für action-Flag.`); continue; }
        addWrite(f.flag, f.value, host, `action line ${norm(ln.timeline_id)}#${norm(ln.order)}`);
      }
    }
    // (3) combat_events.effects set_flag — Host-Step = battle-Step mit diesem Event
    for (const ev of combat) {
      const id = norm(ev.event_id);
      const hosts = battleStepByEvent[id] || [];
      if (!hosts.length) warn(`combat_event "${id}": von keinem battle-Step referenziert (battle_events).`);
      for (const f of parseSetFlags(ev.effects))
        for (const host of hosts) addWrite(f.flag, f.value, host, `combat_event ${id}`);
    }
    // (4) end-Step -> gesetztes Flag. ref-Spalte hat VORRANG; ist sie leer,
    //     Fallback "{chapter_id}_completed". So können zusammenführende
    //     Sub-Branches absichtlich DASSELBE Flag setzen (Merge), und Bad-Ends
    //     ein eigenes (z.B. game_over_aldric_dead).
    for (const n of nodes) if (n.type === "end") {
      const flag = n.ref || `${n.chapter}_completed`;
      n.endFlag = flag;
      n.intentionalEnd = /^(game_over_|ending_)/i.test(flag);
      addWrite(flag, "true", n.id, `end-step ${n.id}`);
    }

    /* ---------- Flag-Lesevorgänge sammeln ---------- */
    const reads = []; // {flag, value, nodeId, as, matchValue}
    const addRead = (flag, value, nodeId, as, matchValue) => {
      if (!flag || !nodeId) return;
      reads.push({ flag, value, nodeId, as, matchValue });
      const n = nodeById[nodeId];
      if (n) n.readsFlags.push({ flag, value, as });
    };
    // (Kapitel-Eintritt wird NICHT mehr als generische Flag-Brücke behandelt –
    //  die Verkettung Ende→Anfang erfolgt unten gezielt über "chapter"-Kanten.)
    // chapters.branch_flag -> branch-Step (wertUNabhängig: jede Änderung ist relevant)
    for (const n of nodes) if (n.branch && n.branch.flag)
      addRead(n.branch.flag, n.branch.value, n.id, "branch", false);
    // chapters.condition_flag -> Step-Gate (wertgenau)
    for (const n of nodes) if (n.condition_flag)
      addRead(n.condition_flag, n.condition_value, n.id, "step-condition", true);

    /* ---------- Flag-Brücken-Kanten ---------- */
    // Pro (write, read) mit gleichem Flag. Wertgenaue Reader (entry/condition)
    // nur bei passendem Wert; branch-Reader matchen wertunabhängig und
    // annotieren, welchen Zweig der geschriebene Wert auslöst.
    for (const w of writes) {
      for (const r of reads) {
        if (r.flag !== w.flag) continue;
        if (r.matchValue && r.value !== "" && r.value !== w.value) continue;
        if (w.nodeId === r.nodeId) continue;          // kein Selbstbezug
        const sameChapter = nodeById[w.nodeId].chapter === nodeById[r.nodeId].chapter;
        let reason = `${w.via} schreibt ${w.flag}=${w.value} → `;
        if (r.as === "branch") {
          const branchSide = (w.value === r.value) ? "true-Zweig" : "false-Zweig";
          reason += `branch "${r.nodeId}" liest ${w.flag} (Wert ${w.value} ⇒ ${branchSide})`;
        } else if (r.as === "chapter-entry") {
          reason += `Kapitel-Eintritt "${r.nodeId}" (gated ${r.flag}=${r.value})`;
        } else {
          reason += `${r.as} "${r.nodeId}" (${r.flag}=${r.value})`;
        }
        addEdge({
          from: w.nodeId, to: r.nodeId, kind: "flag",
          scope: sameChapter ? "intra" : "inter",
          label: `${w.flag}=${w.value}`,
          reason,
        });
      }
    }

    /* ---------- ÄNDERUNG 2: Kapitel-Verkettung (Ende → nächster Anfang) ---------- */
    // Producible-Flags je Name (aus ALLEN Quellen). End-Step-Writer sind die
    // "Completion-Flags" – nur sie verketten Kapitel; die übrigen Bedingungen
    // (Diskriminatoren wie route/Pfadwahl) werden zum Kanten-Label.
    const writesByFlag = {};
    for (const w of writes) (writesByFlag[w.flag] = writesByFlag[w.flag] || []).push(w);
    const isEndWriter = (w) => nodeById[w.nodeId] && nodeById[w.nodeId].type === "end";

    // Welche Flags werden von IRGENDEINER entry_conditions konsumiert?
    const consumedByEntry = new Set();
    for (const c of chapters) for (const cond of c.entryConditions) consumedByEntry.add(cond.flag);

    const bridgedFlags = new Set();
    const issues = [];                                // gefüllt hier + Sackgassen unten

    for (const c of chapters) {
      const conds = c.entryConditions;
      if (!conds.length || !c.entryStep) continue;    // Startkapitel / ohne Steps
      const condInfo = conds.map(cond => {
        const all = writesByFlag[cond.flag] || [];
        const valMatch = all.filter(w => cond.value === "" || w.value === cond.value);
        return { cond, valMatch, endWriters: valMatch.filter(isEndWriter), produced: all.length > 0 };
      });

      // ÄNDERUNG 3a: Unerreichbar, wenn ein benötigtes Flag (UND-Logik) von
      // KEINEM Kapitel produziert wird.
      const missing = condInfo.filter(ci => !ci.produced).map(ci => ci.cond.flag);
      if (missing.length) {
        const d = { severity: "unreachable", node: c.entryStep,
          message: `Kapitel "${c.id}" ist unerreichbar: Flag(s) ${missing.join(", ")} aus entry_conditions werden von keinem Kapitel produziert.` };
        nodeById[c.entryStep].diagnostics.push(d); issues.push(d);
      }

      // Link-Bedingungen = Bedingungen, deren Flag ein end-Step setzt.
      const linkConds = condInfo.filter(ci => ci.endWriters.length);
      // Diskriminatoren = alle übrigen Bedingungen → Kanten-Label.
      const discrim = conds
        .filter(cond => !linkConds.some(lc => lc.cond === cond))
        .map(cond => `${cond.flag}=${cond.value}`).join("; ");

      if (linkConds.length) {
        // Kante vom end-Step jedes Vorgängers zum ersten Step von B.
        for (const lc of linkConds) {
          bridgedFlags.add(lc.cond.flag);
          for (const w of lc.endWriters) {
            if (w.nodeId === c.entryStep) continue;
            addEdge({ from: w.nodeId, to: c.entryStep, kind: "chapter", scope: "inter",
              label: discrim,
              reason: `Kapitel "${nodeById[w.nodeId].chapter}" endet (setzt ${lc.cond.flag}=${lc.cond.value}) → Eintritt "${c.id}"` +
                      (discrim ? ` unter Bedingung ${discrim}` : " (Merge)") });
          }
        }
      } else {
        // Kein Completion-Flag eines end-Steps in den Bedingungen (z.B. reines
        // Discriminator-Gate / Alt-Schema): Flag-Brücke vom produzierenden Step.
        for (const ci of condInfo) {
          bridgedFlags.add(ci.cond.flag);
          for (const w of ci.valMatch) {
            if (w.nodeId === c.entryStep) continue;
            const sameChapter = nodeById[w.nodeId].chapter === c.id;
            addEdge({ from: w.nodeId, to: c.entryStep, kind: "flag",
              scope: sameChapter ? "intra" : "inter",
              label: `${ci.cond.flag}=${ci.cond.value}`,
              reason: `${w.via} setzt ${ci.cond.flag}=${ci.cond.value} → Eintritt "${c.id}"` });
          }
        }
      }
    }

    /* ---------- Flag-Register (Übersicht / unverbrauchte Flags) ---------- */
    const flags = {};
    const ensureFlag = (f) => (flags[f] = flags[f] || { writes: [], reads: [], bridged: false });
    for (const w of writes) ensureFlag(w.flag).writes.push({ node: w.nodeId, value: w.value, via: w.via });
    for (const r of reads)  ensureFlag(r.flag).reads.push({ node: r.nodeId, value: r.value, as: r.as });
    // Eintritts-Bedingungen zählen als Lesevorgang (Konsum) des Flags.
    for (const c of chapters) for (const cond of c.entryConditions)
      ensureFlag(cond.flag).reads.push({ node: c.entryStep, value: cond.value, as: "chapter-entry" });
    for (const e of edges) if (e.kind === "flag") {
      const f = e.label.split("=")[0];
      if (flags[f]) flags[f].bridged = true;
    }
    for (const f of bridgedFlags) if (flags[f]) flags[f].bridged = true;
    for (const f in flags) {
      const fr = flags[f];
      // Gewollte Ende-Flags (game_over_/ending_) sind absichtlich Terminals –
      // kein Lesevorgang erwartet, daher keine "nirgends gelesen"-Warnung.
      const intentional = /^(game_over_|ending_)/i.test(f);
      if (fr.writes.length && !fr.reads.length && !intentional) warn(`Flag "${f}" wird geschrieben, aber nirgends gelesen.`);
      if (fr.reads.length && !fr.writes.length) warn(`Flag "${f}" wird gelesen, aber nirgends geschrieben.`);
    }

    /* ---------- ÄNDERUNG 3b: Sackgassen & gewollte Enden ---------- */
    // Pro end-Step das gesetzte Flag (n.endFlag, s. ÄNDERUNG 1) klassifizieren:
    //   • intentional-end (neutral): Flag wie ein Ende benannt
    //     (Präfix game_over_ / ending_) → gewollter Terminal-Knoten.
    //   • dead-end (rot): Flag wird von KEINER entry_conditions konsumiert UND
    //     ist kein gewolltes Ende → echte Sackgasse (vergessene Verknüpfung).
    //   • sonst: Connector-Ende (Completion-Flag eines Folgekapitels) → ok.
    for (const n of nodes) {
      if (n.type !== "end") continue;
      const F = n.endFlag;
      if (n.intentionalEnd) {
        const d = { severity: "intentional-end", node: n.id,
          message: `Gewolltes Ende: "${n.id}" setzt "${F}" (intentionaler Terminal-Knoten).` };
        n.diagnostics.push(d); issues.push(d);
      } else if (!consumedByEntry.has(F)) {
        const d = { severity: "dead-end", node: n.id,
          message: `Sackgasse: "${n.id}" setzt "${F}", aber kein Kapitel liest dieses Flag in entry_conditions — und es ist kein gewolltes Ende (game_over_/ending_).` };
        n.diagnostics.push(d); issues.push(d);
      }
    }

    /* ---------- Drill-down je Step ---------- */
    const drilldown = {};
    for (const n of nodes) {
      if (n.type === "dialog") {
        const tl = tlById[n.ref] || null;
        const tlLines = (linesByTl[n.ref] || []).map(ln => ({
          order: numOr(ln.order, 0),
          speaker: norm(ln.speaker),
          speakerName: (charById[norm(ln.speaker)] && charById[norm(ln.speaker)].display_name) || norm(ln.speaker),
          text: norm(ln.text_de),
          emotion: norm(ln.emotion),
          condition: norm(ln.condition_flag) ? { flag: norm(ln.condition_flag), value: norm(ln.condition_value) } : null,
          action: norm(ln.action),
          choiceGroup: norm(ln.choice_group) || null,
        }));
        const groups = {};
        for (const ln of tlLines) if (ln.choiceGroup && !groups[ln.choiceGroup])
          groups[ln.choiceGroup] = (choicesByGroup[ln.choiceGroup] || []).map(c => ({
            order: numOr(c.option_order, 0), impact: norm(c.impact),
            text: norm(c.text_de), description: norm(c.description),
            setFlag: norm(c.set_flag), setValue: norm(c.set_value),
          }));
        drilldown[n.id] = { kind: "dialog", timeline: tl ? { ...tl } : null, lines: tlLines, choiceGroups: groups };
      } else if (n.type === "battle") {
        drilldown[n.id] = {
          kind: "battle", map: n.ref,
          events: n.battle_events.map(id => {
            const ev = combatById[id] || null;
            return ev ? {
              id, trigger_type: norm(ev.trigger_type), trigger_value: norm(ev.trigger_value),
              once: norm(ev.once), effects: splitEffects(ev.effects),
              startsTimeline: (splitEffects(ev.effects).find(e => /^start_timeline:/i.test(e)) || "").split(":")[1] || null,
            } : { id, missing: true };
          }),
        };
      }
    }

    return { nodes, edges, chapters, flags, drilldown, warnings, issues,
             counts: { nodes: nodes.length, edges: edges.length,
                       flagEdges: edges.filter(e => e.kind === "flag").length,
                       chapterEdges: edges.filter(e => e.kind === "chapter").length,
                       deadEnds: issues.filter(i => i.severity === "dead-end").length,
                       unreachable: issues.filter(i => i.severity === "unreachable").length,
                       intentionalEnds: issues.filter(i => i.severity === "intentional-end").length } };
  }

  /* ---------- kleine Helfer ---------- */
  // "flag=value; flag2=value2" -> [{flag, value}, ...] (UND-Liste). Ein Eintrag
  // ohne '=' wird als {flag, value:""} gelesen (wertunabhängige Bedingung).
  function parseConditions(s) {
    return norm(s).split(";").map(x => x.trim()).filter(Boolean).map(part => {
      const i = part.indexOf("=");
      return i === -1 ? { flag: part.trim(), value: "" }
                      : { flag: part.slice(0, i).trim(), value: part.slice(i + 1).trim() };
    });
  }
  function index(arr, key) { const m = {}; for (const r of arr) { const k = norm(r[key]); if (k) m[k] = r; } return m; }
  function groupBy(arr, key) { const m = {}; for (const r of arr) { const k = norm(r[key]); if (!k) continue; (m[k] = m[k] || []).push(r); } return m; }

  SDV.SCHEMA = SCHEMA;
  SDV.TAB_ORDER = TAB_ORDER;
  SDV.buildGraph = buildGraph;
})();
