/* ============================================================
   Skill-Liste
   Kombiniert „Aktive Skills“ und „Passive Skills“ aus dem Google
   Sheet zu einer durchsuch-/filterbaren Liste.
   Teilt sich die Sheet-URL über localStorage mit dem
   Klassenbaum-Visualizer (gleicher Key, gleiche Origin).
   ============================================================ */
"use strict";

const LS_KEY = "ktv-settings-v2";          // geteilt mit dem Klassenbaum-Tool
const SKILL_GIDS = { Aktiv: "1539405646", Passiv: "1121351090" };

const state = {
  sheetRef: "",
  skills: [],          // [{type, name, desc, extra:[{label,value}]}]
  query: "",
  filter: "all",
};

const el = {
  list:    document.getElementById("list"),
  search:  document.getElementById("searchInput"),
  filters: document.getElementById("filters"),
  count:   document.getElementById("count"),
  overlay: document.getElementById("overlay"),
  spinner: document.getElementById("spinner"),
  overlayMsg: document.getElementById("overlayMsg"),
  overlayActions: document.getElementById("overlayActions"),
};

/* ---------- CSV-Parser (identisch zum Klassenbaum-Tool) ---------- */
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = [], field = "", q = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  row.push(field); rows.push(row);
  return rows.filter(r => r.some(f => f.trim() !== ""));
}

function buildCsvUrl(ref, gid) {
  ref = (ref || "").trim();
  let m = ref.match(/\/d\/e\/([^\/?#]+)/);
  if (m) return `https://docs.google.com/spreadsheets/d/e/${m[1]}/pub?output=csv&single=true&gid=${encodeURIComponent(gid)}`;
  if (/^2PACX/i.test(ref)) return `https://docs.google.com/spreadsheets/d/e/${ref}/pub?output=csv&single=true&gid=${encodeURIComponent(gid)}`;
  m = ref.match(/\/d\/([^\/?#]+)/);
  const id = m ? m[1] : ref;
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}

/* ---------- Parsen eines Skill-Tabs ---------- */
function parseSkillTab(csvText, type) {
  const rows = parseCSV(csvText);
  if (!rows.length) return [];
  let h = rows.findIndex(r => r.some(c => c.trim().toLowerCase() === "name"));
  if (h === -1) h = 0;
  const headers = rows[h].map(x => x.trim());
  const lower = headers.map(x => x.toLowerCase());
  const nameI = lower.findIndex(x => x.includes("name"));
  const descI = lower.findIndex(x => x.includes("beschreib"));
  const out = [];
  for (let r = h + 1; r < rows.length; r++) {
    const cols = rows[r];
    const name = (cols[nameI] || "").trim();
    if (!name) continue;
    const extra = [];
    headers.forEach((hd, i) => {
      if (i === nameI || i === descI) return;
      const v = (cols[i] || "").trim();
      if (v) extra.push({ label: hd, value: v });
    });
    out.push({ type, name, desc: (descI >= 0 ? cols[descI] : "").trim(), extra });
  }
  return out;
}

/* ---------- Laden ---------- */
async function loadSkills() {
  if (!state.sheetRef) { showUrlPrompt(); return; }
  showOverlay({ loading: true, msg: "Lade Skills aus Google Sheets…" });
  try {
    const all = [];
    for (const type of Object.keys(SKILL_GIDS)) {
      const resp = await fetch(buildCsvUrl(state.sheetRef, SKILL_GIDS[type]), { redirect: "follow" });
      if (!resp.ok) throw new Error(`„${type}e Skills“: HTTP ${resp.status}. Prüfe URL/GID und Freigabe.`);
      const text = await resp.text();
      if (/^\s*<(!doctype|html)/i.test(text))
        throw new Error(`„${type}e Skills“: Antwort war HTML statt CSV.\nIst das Sheet „Im Web veröffentlicht“?`);
      all.push(...parseSkillTab(text, type));
    }
    state.skills = all;
    hideOverlay();
    render();
    applyHashHighlight();
  } catch (err) {
    showOverlay({
      error: true, msg: `Fehler beim Laden:\n\n${err.message || err}`,
      actions: [
        { label: "↻ Erneut versuchen", fn: loadSkills },
        { label: "⚙ Sheet-Link ändern", fn: showUrlPrompt },
      ],
    });
  }
}

/* ---------- Rendern ---------- */
function render() {
  const q = state.query.trim().toLowerCase();
  const items = state.skills.filter(s => {
    if (state.filter !== "all" && s.type !== state.filter) return false;
    if (!q) return true;
    return s.name.toLowerCase().includes(q) || (s.desc || "").toLowerCase().includes(q);
  }).sort((a, b) => a.name.localeCompare(b.name, "de"));

  el.count.textContent = `${items.length} / ${state.skills.length}`;
  el.list.innerHTML = "";
  if (!items.length) {
    el.list.innerHTML = `<div class="empty">Keine Skills gefunden.</div>`;
    return;
  }
  for (const s of items) {
    const cls = s.type.toLowerCase(); // aktiv / passiv
    const div = document.createElement("div");
    div.className = `skill ${cls}`;
    div.id = "skill-" + slug(s.name);
    const meta = s.extra.map(e =>
      `<span><span class="k">${esc(e.label)}:</span> ${esc(e.value)}</span>`).join("");
    div.innerHTML = `
      <div class="skill-head">
        <span class="skill-name">${esc(s.name)}</span>
        <span class="badge ${cls}">${esc(s.type)}</span>
      </div>
      ${s.desc ? `<div class="skill-desc">${esc(s.desc)}</div>` : ""}
      ${meta ? `<div class="skill-meta">${meta}</div>` : ""}`;
    el.list.appendChild(div);
  }
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* Deep-Link: #skill=<Name> -> hervorheben + hinscrollen.
   Wird vom Klassenbaum-Tool genutzt (Klick auf eine Fähigkeit). */
function applyHashHighlight() {
  const m = location.hash.match(/skill=([^&]+)/);
  if (!m) return;
  const name = decodeURIComponent(m[1]);
  // Filter/Suche zurücksetzen, damit der Treffer sichtbar ist
  state.query = ""; state.filter = "all";
  el.search.value = "";
  el.filters.querySelectorAll(".filter").forEach(b => b.classList.toggle("active", b.dataset.type === "all"));
  render();
  const target = document.getElementById("skill-" + slug(name));
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove("flash"); void target.offsetWidth; target.classList.add("flash");
  }
}

/* ---------- Overlay ---------- */
function showOverlay({ loading = false, error = false, msg = "", actions = [] } = {}) {
  el.overlay.classList.remove("hidden");
  el.spinner.classList.toggle("hidden", !loading);
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

function showUrlPrompt() {
  showOverlay({
    msg: "Google-Sheet-Link einfügen\n(„Im Web veröffentlichen“-CSV-URL …/d/e/…/pub  oder  Spreadsheet-ID).\nWird nur lokal in deinem Browser gespeichert (geteilt mit dem Klassenbaum-Tool).",
  });
  const input = document.createElement("input");
  input.type = "text"; input.placeholder = "https://docs.google.com/…/pub?output=csv";
  input.value = state.sheetRef || "";
  const load = document.createElement("button");
  load.className = "btn"; load.textContent = "Laden";
  const submit = () => {
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    state.sheetRef = v; persistSheetRef(v);
    loadSkills();
  };
  load.addEventListener("click", submit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
  el.overlayActions.append(input, load);
  setTimeout(() => input.focus(), 0);
}

/* ---------- Settings (geteilte Sheet-URL) ---------- */
function loadSheetRef() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { const p = JSON.parse(raw); state.sheetRef = p.sheetRef || ""; }
  } catch (e) { console.warn("localStorage:", e); }
}
function persistSheetRef(ref) {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const p = raw ? JSON.parse(raw) : {};
    p.sheetRef = ref;
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch (e) { console.warn("localStorage:", e); }
}

/* ---------- Init ---------- */
function init() {
  loadSheetRef();
  let t;
  el.search.addEventListener("input", e => {
    state.query = e.target.value;
    clearTimeout(t); t = setTimeout(render, 120);
  });
  el.filters.querySelectorAll(".filter").forEach(btn => {
    btn.addEventListener("click", () => {
      state.filter = btn.dataset.type;
      el.filters.querySelectorAll(".filter").forEach(b => b.classList.toggle("active", b === btn));
      render();
    });
  });
  document.getElementById("reloadBtn").addEventListener("click", loadSkills);
  document.getElementById("settingsBtn").addEventListener("click", showUrlPrompt);
  window.addEventListener("hashchange", applyHashHighlight);
  loadSkills();
}
document.addEventListener("DOMContentLoaded", init);
