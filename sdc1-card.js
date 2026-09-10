/*!
 * SDC-1 Access Control Card
 * Deanex International — https://github.com/deanex-international/sdc-1
 *
 * One card for the whole device: door state, passage/lockdown, the enrolled
 * roster with delete, and the enrollment workflow.
 *
 * No build step and no dependencies: this is a plain custom element, so HACS
 * copies one file and it works.
 *
 * Three cards ship from this one file, because HACS installs a single file per
 * plugin repository:
 *
 *   type: custom:sdc1-card             door, roster, enrollment
 *   type: custom:sdc1-schedule-card    per-person access hours
 *   type: custom:sdc1-duress-card      duress credentials
 *
 * All accept an optional `prefix:` (entity_id prefix, default sdc_1).
 */

const VERSION = "1.4.0";

// Entity suffixes this card looks for, keyed by role. Anything not found is
// simply hidden, so a partially-configured device still renders.
const WANTED = {
  lock:            { domain: "lock",          re: /_door$/ },
  passage:         { domain: "switch",        re: /_passage_mode$/ },
  passageAutoOff:  { domain: "switch",        re: /_passage_auto_off$/ },
  lockdown:        { domain: "switch",        re: /_lockdown$/ },
  lastBy:          { domain: "sensor",        re: /_last_unlocked_by$/ },
  lastAt:          { domain: "sensor",        re: /_last_unlocked_at$/ },
  people:          { domain: "sensor",        re: /_enrolled_people$/ },
  // v5.10.0 named these "<reader> Users"; v5.11.0 renamed them to "Enrolled"
  // because Home Assistant strips the sub-device name and both the list and
  // the count then displayed as plain "Users". Match either spelling.
  peopleFp:        { domain: "sensor",        re: /_fingerprint_(users|enrolled)$/ },
  peopleFace:      { domain: "sensor",        re: /_face_id_(users|enrolled)$/ },
  peopleNfc:       { domain: "sensor",        re: /_nfc_(users|enrolled)$/ },
  peopleCount:     { domain: "sensor",        re: /_registered_people$/ },
  dbUsage:         { domain: "sensor",        re: /_database_usage$/ },
  lockoutStatus:   { domain: "sensor",        re: /_lockout_status$/ },
  lockoutActive:   { domain: "binary_sensor", re: /_lockout_active$/ },
  enrollStatus:    { domain: "sensor",        re: /_enrollment_status$/ },
  enrollName:      { domain: "text",          re: /_enroll_name$/ },
  fpEnroll:        { domain: "button",        re: /_fp_start_enrollment$/ },
  faceEnroll:      { domain: "button",        re: /_face_start_enrollment$/ },
  nfcEnroll:       { domain: "button",        re: /_nfc_link_next_tag$/ },
  // Firmware <= 5.10.0 called this "Cancel Enrollment"; 5.10.1 renamed it to
  // "Enroll: Cancel" so it sorts beside the name field. Match either.
  cancelEnroll:    { domain: "button",        re: /_(cancel_enrollment|enroll_cancel)$/ },
  clearLockout:    { domain: "button",        re: /_clear_lockout$/ },
};

// Entity IDs follow the Home Assistant DEVICE name, which anyone can rename.
// ESPHome registers its actions under the NODE name from the YAML, which cannot
// be renamed from Home Assistant. Rename the device and the two diverge — the
// entities become office_sdc_1_* while the action stays esphome.sdc_1_*.
//
// So never derive an action name from the entity prefix: look it up in the
// service registry, and fall back to the prefix only if nothing matches.
function esphomeService(hass, prefix, suffix) {
  const svcs = (hass && hass.services && hass.services.esphome) || {};
  const names = Object.keys(svcs).filter((s) => s.endsWith("_" + suffix));
  if (!names.length) return prefix + "_" + suffix;
  // Prefer one that matches the configured prefix, so several SDC-1s on one
  // installation still target the right device.
  return names.find((s) => s.startsWith(prefix)) || names[0];
}

// Credential filters for the roster list. Kept out of the render template so
// the markup stays free of nested interpolation.
const FILTERS = [
  { key: "all", label: "All" },
  { key: "fp", label: "Fingerprint" },
  { key: "fc", label: "Face ID" },
  { key: "nfc", label: "NFC" },
];

class Sdc1Card extends HTMLElement {
  constructor() {
    super();
    this._built = false;
    this._roster = null;       // [{n, fp, fc, nfc}] from the device event
    this._unsub = null;
    this._primed = false;
    this._busy = false;
    this._filter = "all";   // all | fp | fc | nfc
  }

  static getStubConfig() {
    return { type: "custom:sdc1-card", prefix: "sdc_1" };
  }

  setConfig(config) {
    this._config = Object.assign({ prefix: "sdc_1" }, config || {});
    this._ids = null;
  }

  getCardSize() {
    return 9;
  }

  disconnectedCallback() {
    if (this._unsub) {
      try { this._unsub.then((u) => u && u()); } catch (e) { /* already gone */ }
      this._unsub = null;
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._ids) this._ids = this._discover(hass);
    if (!this._built) this._build();
    this._subscribeRoster();
    this._render();
  }

  // -- entity discovery ------------------------------------------------------
  // Matching by suffix against a prefix survives the sub-device grouping added
  // in firmware v5.6.0, which can change how HA composes entity_ids.
  _discover(hass) {
    const prefix = this._config.prefix;
    const found = {};
    const all = Object.keys(hass.states);
    for (const [role, spec] of Object.entries(WANTED)) {
      if (this._config[role]) { found[role] = this._config[role]; continue; }
      const hit = all.find((id) => {
        if (!id.startsWith(spec.domain + ".")) return false;
        const obj = id.slice(spec.domain.length + 1);
        return obj.startsWith(prefix) && spec.re.test(obj);
      });
      if (hit) found[role] = hit;
    }
    return found;
  }

  _st(role) {
    const id = this._ids && this._ids[role];
    if (!id || !this._hass.states[id]) return null;
    return this._hass.states[id];
  }

  _val(role, fallback = "—") {
    const s = this._st(role);
    if (!s || s.state === "unknown" || s.state === "unavailable") return fallback;
    return s.state;
  }

  // -- roster ----------------------------------------------------------------
  // The device emits the full database as an event because an HA entity state
  // caps at 255 characters. Subscribing gives per-person credential detail;
  // the Enrolled People text sensor is the fallback when no event has fired.
  _subscribeRoster() {
    if (this._unsub || !this._hass.connection) return;
    this._unsub = this._hass.connection.subscribeEvents((ev) => {
      try {
        const db = ev && ev.data && ev.data.db;
        if (typeof db === "string") {
          this._roster = JSON.parse(db);
          this._render();
        }
      } catch (e) {
        // A malformed payload must never take the card down.
        console.warn("sdc1-card: could not parse roster", e);
      }
    }, "esphome.sdc1_roster");

    // Ask once for a fresh roster, since the event only fires on change.
    if (!this._primed) {
      this._primed = true;
      const svc = esphomeService(this._hass, this._config.prefix, "publish_roster");
      this._hass.callService("esphome", svc, {}).catch(() => {
        // Older firmware without the action; the text sensor still works.
      });
    }
  }

  _people() {
    if (Array.isArray(this._roster)) {
      return this._roster.map((r) => ({
        name: r.n,
        fp: typeof r.fp === "number" && r.fp >= 0,
        fc: typeof r.fc === "number" && r.fc >= 0,
        nfc: !!r.nfc,
      }));
    }
    const role = { all: "people", fp: "peopleFp", fc: "peopleFace", nfc: "peopleNfc" }[this._filter];
    const txt = this._val(role, "");
    if (!txt || txt.startsWith("(")) return [];
    return txt
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n && !/^\+\d+ more$/.test(n))
      .map((n) => ({ name: n, fp: null, fc: null, nfc: null }));
  }

  // -- actions ---------------------------------------------------------------
  _call(domain, service, data) {
    this._busy = true;
    this._render();
    return this._hass
      .callService(domain, service, data)
      .catch((e) => console.error("sdc1-card:", e))
      .finally(() => { this._busy = false; this._render(); });
  }

  _press(role) {
    const id = this._ids[role];
    if (id) this._call("button", "press", { entity_id: id });
  }

  _toggle(role) {
    const id = this._ids[role];
    if (id) this._call("switch", "toggle", { entity_id: id });
  }

  _deletePerson(name) {
    const ok = window.confirm(
      "Permanently revoke access for “" + name + "”?\n\n" +
      "This removes their fingerprint, face and NFC credentials from the reader."
    );
    if (!ok) return;
    this._call("esphome",
      esphomeService(this._hass, this._config.prefix, "delete_person"),
      { person_name: name });
  }

  _startEnroll(role) {
    const name = (this._nameInput && this._nameInput.value || "").trim();
    if (!name) {
      window.alert("Enter a name first.");
      return;
    }
    const textId = this._ids.enrollName;
    const go = () => this._press(role);
    if (textId) {
      this._call("text", "set_value", { entity_id: textId, value: name }).then(go);
    } else {
      go();
    }
  }

  // -- rendering -------------------------------------------------------------
  _build() {
    this._built = true;
    this.innerHTML = `
      <ha-card>
        <style>
          .sdc1 { padding: 12px 16px 16px; }
          .sdc1 h2 { margin: 0 0 2px; font-size: 1.25rem; font-weight: 500;
                     color: var(--primary-text-color); }
          .sdc1 .sub { color: var(--secondary-text-color); font-size: .85rem;
                       margin-bottom: 14px; }
          .sdc1 .state { display:flex; align-items:center; gap:10px;
                         padding:12px 14px; border-radius:12px; margin-bottom:12px;
                         background: var(--secondary-background-color); }
          .sdc1 .dot { width:12px; height:12px; border-radius:50%; flex:none; }
          .sdc1 .dot.locked   { background: var(--label-badge-green,   #43a047); }
          .sdc1 .dot.unlocked { background: var(--label-badge-yellow,  #ffa600); }
          .sdc1 .dot.alarm    { background: var(--error-color,         #db4437); }
          .sdc1 .state .txt { font-weight:500; color: var(--primary-text-color); }
          .sdc1 .state .meta{ margin-left:auto; text-align:right; font-size:.78rem;
                              color: var(--secondary-text-color); line-height:1.35; }
          .sdc1 .row { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
          .sdc1 button { font: inherit; font-size:.86rem; cursor:pointer;
                         border-radius:10px; padding:8px 14px;
                         border:1px solid var(--divider-color);
                         background: var(--card-background-color);
                         color: var(--primary-text-color); transition: .15s; }
          .sdc1 button:hover:not(:disabled) { border-color: var(--primary-color); }
          .sdc1 button:disabled { opacity:.45; cursor:default; }
          .sdc1 button.on { background: var(--primary-color); color: var(--text-primary-color,#fff);
                            border-color: var(--primary-color); }
          .sdc1 button.danger { color: var(--error-color); border-color: var(--error-color); }
          .sdc1 .filters { gap:6px; margin-bottom:10px; }
          .sdc1 .filters button { padding:5px 12px; font-size:.8rem; border-radius:20px; }
          .sdc1 h3 { margin:16px 0 8px; font-size:.78rem; letter-spacing:.07em;
                     text-transform:uppercase; color: var(--secondary-text-color); }
          .sdc1 ul { list-style:none; margin:0; padding:0; }
          .sdc1 li { display:flex; align-items:center; gap:10px; padding:9px 0;
                     border-bottom:1px solid var(--divider-color); }
          .sdc1 li:last-child { border-bottom:none; }
          .sdc1 .who { font-weight:500; color: var(--primary-text-color); }
          .sdc1 .creds { display:flex; gap:5px; margin-left:auto; }
          .sdc1 .chip { font-size:.68rem; padding:2px 7px; border-radius:20px;
                        background: var(--secondary-background-color);
                        color: var(--secondary-text-color); }
          .sdc1 .chip.has { background: var(--primary-color);
                            color: var(--text-primary-color,#fff); }
          .sdc1 .empty { color: var(--secondary-text-color); font-size:.86rem;
                         padding:10px 0; }
          .sdc1 input { font: inherit; font-size:.9rem; flex:1 1 150px; min-width:0;
                        padding:8px 12px; border-radius:10px;
                        border:1px solid var(--divider-color);
                        background: var(--card-background-color);
                        color: var(--primary-text-color); }
          .sdc1 .status { font-size:.82rem; color: var(--secondary-text-color);
                          margin-top:10px; min-height:1.2em; }
          .sdc1 .miss { font-size:.8rem; color: var(--error-color); padding:8px 0; }
        </style>
        <div class="sdc1"></div>
      </ha-card>`;
    this._root = this.querySelector(".sdc1");
  }

  _render() {
    if (!this._root || !this._hass) return;

    if (!this._ids.lock && !this._ids.people) {
      this._root.innerHTML =
        `<h2>SDC-1</h2><div class="miss">No SDC-1 entities found for prefix
         <code>${this._config.prefix}</code>. Set <code>prefix:</code> in the card
         config to match your device's entity IDs.</div>`;
      return;
    }

    const lockState = this._val("lock", "unknown");
    const lockedOut = this._st("lockoutActive");
    const isAlarm = lockedOut && lockedOut.state === "on";
    const dot = isAlarm ? "alarm" : lockState === "locked" ? "locked" : "unlocked";
    const label = isAlarm
      ? this._val("lockoutStatus", "Locked out")
      : lockState === "locked" ? "Locked" : lockState === "unlocked" ? "Unlocked" : "Unknown";

    const passageOn = this._val("passage") === "on";
    const lockdownOn = this._val("lockdown") === "on";
    const autoOffOn = this._val("passageAutoOff") === "on";
    let people = this._people();
    if (this._filter !== "all" && people.length && people[0].fp !== null) {
      const key = { fp: "fp", fc: "fc", nfc: "nfc" }[this._filter];
      people = people.filter((p) => p[key]);
    }
    const truncated = /\+\d+ more/.test(this._val("people", ""));
    const dis = this._busy ? "disabled" : "";

    const chips = FILTERS.map(
      (f) =>
        '<button data-filter="' + f.key + '" class="' +
        (this._filter === f.key ? "on" : "") + '">' + f.label + "</button>"
    ).join("");

    const rows = people.length
      ? people.map((p) => {
          const chips = p.fp === null
            ? ""
            : `<span class="chip ${p.fp ? "has" : ""}">FP</span>
               <span class="chip ${p.fc ? "has" : ""}">Face</span>
               <span class="chip ${p.nfc ? "has" : ""}">NFC</span>`;
          return `<li><span class="who">${esc(p.name)}</span>
                    <span class="creds">${chips}</span>
                    <button class="danger" data-del="${esc(p.name)}" ${dis}>Remove</button>
                  </li>`;
        }).join("")
      : `<div class="empty">${
          this._filter === "all"
            ? "Nobody is enrolled yet."
            : "Nobody is enrolled on this reader."
        }</div>`;

    this._root.innerHTML = `
      <h2>${esc(this._config.title || "Door Access")}</h2>
      <div class="sub">${people.length} enrolled${
        truncated ? " (list truncated — full roster via the device event)" : ""
      }${this._st("dbUsage") ? " · storage " + this._val("dbUsage") + "%" : ""}</div>

      <div class="state">
        <span class="dot ${dot}"></span>
        <span class="txt">${esc(label)}</span>
        <span class="meta">${esc(this._val("lastBy", "no unlocks yet"))}<br>${esc(
          this._val("lastAt", "")
        )}</span>
      </div>

      <div class="row">
        <button data-act="unlock" ${dis}>Unlock</button>
        <button data-act="passage" class="${passageOn ? "on" : ""}" ${dis}>Passage${
          passageOn && autoOffOn ? " (timed)" : ""
        }</button>
        <button data-act="lockdown" class="${lockdownOn ? "on" : ""}" ${dis}>Lockdown</button>
        ${isAlarm ? `<button data-act="clear" ${dis}>Clear lockout</button>` : ""}
      </div>

      <h3>Enrolled people</h3>
      <div class="row filters">${chips}</div>
      <ul>${rows}</ul>

      <h3>Add someone</h3>
      <div class="row">
        <input id="sdc1-name" type="text" maxlength="31" placeholder="Name"
               value="${esc(this._pendingName || "")}">
        <button data-act="fp" ${dis}>Fingerprint</button>
        <button data-act="face" ${dis}>Face</button>
        <button data-act="nfc" ${dis}>NFC tag</button>
        <button data-act="cancel" ${dis}>Cancel</button>
      </div>
      <div class="status">${esc(this._val("enrollStatus", ""))}</div>`;

    this._nameInput = this._root.querySelector("#sdc1-name");
    if (this._nameInput) {
      this._nameInput.addEventListener("input", (e) => { this._pendingName = e.target.value; });
    }

    this._root.querySelectorAll("[data-filter]").forEach((b) =>
      b.addEventListener("click", () => {
        this._filter = b.getAttribute("data-filter");
        this._render();
      })
    );
    this._root.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", () => this._deletePerson(b.getAttribute("data-del")))
    );
    this._root.querySelectorAll("[data-act]").forEach((b) =>
      b.addEventListener("click", () => {
        switch (b.getAttribute("data-act")) {
          case "unlock":   this._call("lock", "unlock", { entity_id: this._ids.lock }); break;
          case "passage":  this._toggle("passage"); break;
          case "lockdown": this._toggle("lockdown"); break;
          case "clear":    this._press("clearLockout"); break;
          case "fp":       this._startEnroll("fpEnroll"); break;
          case "face":     this._startEnroll("faceEnroll"); break;
          case "nfc":      this._startEnroll("nfcEnroll"); break;
          case "cancel":   this._press("cancelEnroll"); break;
        }
      })
    );
  }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

customElements.define("sdc1-card", Sdc1Card);

// Makes the card appear in the dashboard "Add card" picker.
window.customCards = window.customCards || [];
window.customCards.push({
  type: "sdc1-card",
  name: "SDC-1 Access Control",
  description: "Door state, roster and enrollment for the Deanex SDC-1.",
  preview: true,
  documentationURL: "https://github.com/deanex-international/sdc-1",
});

/* ===========================================================================
 * Shared roster plumbing for the schedule and duress cards.
 *
 * Deliberately standalone rather than refactored out of Sdc1Card: that card is
 * in service, and a little duplication is cheaper than the risk of breaking it.
 *
 * The device emits its whole database on esphome.sdc1_roster whenever it
 * changes, including the per-person "d" (duress) and "h0"/"h1" (access window)
 * fields. Those are not exposed as entities, so the event is the only way a
 * card can see them.
 * ======================================================================== */
class Sdc1RosterCard extends HTMLElement {
  constructor() {
    super();
    this._roster = null;
    this._unsub = null;
    this._primed = false;
    this._busy = false;
    this._open = null; // name of the row being edited
  }

  setConfig(config) {
    this._config = Object.assign({ prefix: "sdc_1" }, config || {});
  }

  getCardSize() {
    return 6;
  }

  disconnectedCallback() {
    if (this._unsub) {
      try { this._unsub.then((u) => u && u()); } catch (e) { /* gone already */ }
      this._unsub = null;
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) {
      this._built = true;
      this.innerHTML = `<ha-card><style>${SDC1_SHARED_CSS}</style><div class="sdc1"></div></ha-card>`;
      this._root = this.querySelector(".sdc1");
    }
    this._subscribe();
    this.render();
  }

  _subscribe() {
    if (this._unsub || !this._hass.connection) return;
    this._unsub = this._hass.connection.subscribeEvents((ev) => {
      try {
        const db = ev && ev.data && ev.data.db;
        if (typeof db === "string") {
          this._roster = JSON.parse(db);
          this.render();
        }
      } catch (e) {
        console.warn("sdc1: bad roster payload", e);
      }
    }, "esphome.sdc1_roster");

    if (!this._primed) {
      this._primed = true;
      this._hass
        .callService(
          "esphome",
          esphomeService(this._hass, this._config.prefix, "publish_roster"),
          {}
        )
        .catch((e) => console.warn("sdc1: could not prime the roster", e));
    }
  }

  people() {
    return Array.isArray(this._roster) ? this._roster : [];
  }

  call(service, data) {
    this._busy = true;
    this.render();
    return this._hass
      .callService(
        "esphome",
        esphomeService(this._hass, this._config.prefix, service),
        data
      )
      .catch((e) => console.error("sdc1:", e))
      .finally(() => {
        this._busy = false;
        // The device re-emits the roster after any change, which re-renders us.
        this._hass
          .callService(
            "esphome",
            esphomeService(this._hass, this._config.prefix, "publish_roster"),
            {}
          )
          .catch(() => {});
      });
  }

  waiting(msg) {
    this._root.innerHTML =
      `<h2>${esc(this._title)}</h2><div class="empty">${esc(msg)}</div>`;
  }
}

const SDC1_SHARED_CSS = `
  .sdc1 { padding: 12px 16px 16px; }
  .sdc1 h2 { margin:0 0 2px; font-size:1.2rem; font-weight:500;
             color:var(--primary-text-color); }
  .sdc1 .sub { color:var(--secondary-text-color); font-size:.85rem; margin-bottom:14px; }
  .sdc1 .note { background:var(--secondary-background-color); border-radius:10px;
                padding:10px 12px; font-size:.82rem; line-height:1.45;
                color:var(--secondary-text-color); margin-bottom:14px; }
  .sdc1 .note b { color:var(--primary-text-color); }
  .sdc1 ul { list-style:none; margin:0; padding:0; }
  .sdc1 li { padding:10px 0; border-bottom:1px solid var(--divider-color); }
  .sdc1 li:last-child { border-bottom:none; }
  .sdc1 .row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .sdc1 .who { font-weight:500; color:var(--primary-text-color); }
  .sdc1 .win { margin-left:auto; font-size:.82rem; color:var(--secondary-text-color); }
  .sdc1 .win.set { color:var(--primary-color); font-weight:500; }
  .sdc1 button { font:inherit; font-size:.84rem; cursor:pointer; border-radius:9px;
                 padding:6px 12px; border:1px solid var(--divider-color);
                 background:var(--card-background-color); color:var(--primary-text-color); }
  .sdc1 button:hover:not(:disabled) { border-color:var(--primary-color); }
  .sdc1 button:disabled { opacity:.45; cursor:default; }
  .sdc1 button.primary { background:var(--primary-color); border-color:var(--primary-color);
                         color:var(--text-primary-color,#fff); }
  .sdc1 button.warn { color:var(--error-color); border-color:var(--error-color); }
  .sdc1 .edit { margin-top:10px; padding:10px 12px; border-radius:10px;
                background:var(--secondary-background-color); }
  .sdc1 select { font:inherit; font-size:.84rem; padding:5px 8px; border-radius:8px;
                 border:1px solid var(--divider-color);
                 background:var(--card-background-color); color:var(--primary-text-color); }
  .sdc1 .empty { color:var(--secondary-text-color); font-size:.86rem; padding:12px 0; }
  .sdc1 .flag { margin-left:auto; display:flex; align-items:center; gap:8px; }
  .sdc1 .pill { font-size:.7rem; padding:2px 8px; border-radius:20px;
                background:var(--secondary-background-color); color:var(--secondary-text-color); }
  .sdc1 .pill.on { background:var(--error-color); color:#fff; }
`;

/* ===========================================================================
 * Access hours
 * ======================================================================== */
class Sdc1ScheduleCard extends Sdc1RosterCard {
  constructor() {
    super();
    this._title = "Access Hours";
  }

  static getStubConfig() {
    return { type: "custom:sdc1-schedule-card", prefix: "sdc_1" };
  }

  render() {
    if (!this._root) return;
    const people = this.people();
    if (!people.length) {
      this.waiting(
        "Waiting for the roster… if this persists, call esphome." +
          esphomeService(this._hass, this._config.prefix, "publish_roster") +
          " by hand."
      );
      return;
    }
    const dis = this._busy ? "disabled" : "";

    const rows = people.map((p) => {
      const has = typeof p.h0 === "number" && typeof p.h1 === "number";
      const label = has ? `${pad2(p.h0)}:00 – ${pad2(p.h1)}:00` : "always";
      const wrap = has && p.h0 > p.h1 ? " (overnight)" : "";
      const editing = this._open === p.n;
      let out =
        `<li><div class="row">
           <span class="who">${esc(p.n)}</span>
           <span class="win ${has ? "set" : ""}">${esc(label + wrap)}</span>
           <button data-edit="${esc(p.n)}" ${dis}>${editing ? "Close" : "Change"}</button>
         </div>`;
      if (editing) {
        out += `<div class="edit">
            <div class="row">
              <span>From</span>${hourSelect("h0-" + p.n, has ? p.h0 : 8, 23)}
              <span>until</span>${hourSelect("h1-" + p.n, has ? p.h1 : 18, 24)}
              <button class="primary" data-save="${esc(p.n)}" ${dis}>Save</button>
              <button class="warn" data-clear="${esc(p.n)}" ${dis}>Clear</button>
            </div>
          </div>`;
      }
      return out + "</li>";
    }).join("");

    this._root.innerHTML = `
      <h2>Access Hours</h2>
      <div class="sub">${people.length} enrolled</div>
      <div class="note">
        Someone outside their window is refused, but this is <b>not</b> treated as
        an attack: it does not count toward the lockout, so one person's hours can
        never lock everyone else out. "Always" means unrestricted. Setting
        <b>from</b> later than <b>until</b> wraps past midnight, e.g. 22:00–06:00.
      </div>
      <ul>${rows}</ul>`;

    this._root.querySelectorAll("[data-edit]").forEach((b) =>
      b.addEventListener("click", () => {
        const n = b.getAttribute("data-edit");
        this._open = this._open === n ? null : n;
        this.render();
      })
    );
    this._root.querySelectorAll("[data-save]").forEach((b) =>
      b.addEventListener("click", () => {
        const n = b.getAttribute("data-save");
        const h0 = parseInt(this._root.querySelector("#h0-" + cssId(n)).value, 10);
        const h1 = parseInt(this._root.querySelector("#h1-" + cssId(n)).value, 10);
        this._open = null;
        this.call("set_schedule", { person_name: n, start_hour: h0, end_hour: h1 });
      })
    );
    this._root.querySelectorAll("[data-clear]").forEach((b) =>
      b.addEventListener("click", () => {
        const n = b.getAttribute("data-clear");
        this._open = null;
        this.call("set_schedule", { person_name: n, start_hour: -1, end_hour: -1 });
      })
    );
  }
}

/* ===========================================================================
 * Duress
 * ======================================================================== */
class Sdc1DuressCard extends Sdc1RosterCard {
  constructor() {
    super();
    this._title = "Duress Credentials";
  }

  static getStubConfig() {
    return { type: "custom:sdc1-duress-card", prefix: "sdc_1" };
  }

  render() {
    if (!this._root) return;
    const people = this.people();
    if (!people.length) {
      this.waiting(
        "Waiting for the roster… if this persists, call esphome." +
          esphomeService(this._hass, this._config.prefix, "publish_roster") +
          " by hand."
      );
      return;
    }
    const dis = this._busy ? "disabled" : "";
    const flagged = people.filter((p) => p.d === 1).length;

    const rows = people.map((p) => {
      const on = p.d === 1;
      return `<li><div class="row">
          <span class="who">${esc(p.n)}</span>
          <span class="flag">
            <span class="pill ${on ? "on" : ""}">${on ? "DURESS" : "normal"}</span>
            <button data-toggle="${esc(p.n)}" data-to="${on ? "0" : "1"}" ${dis}>
              ${on ? "Clear" : "Mark"}
            </button>
          </span>
        </div></li>`;
    }).join("");

    this._root.innerHTML = `
      <h2>Duress Credentials</h2>
      <div class="sub">${flagged} of ${people.length} marked</div>
      <div class="note">
        A duress credential <b>opens the door exactly as normal</b>. Nothing on the
        device, in the log or in this dashboard marks the unlock as unusual — that
        is the point, so that someone being forced to open the door is not put at
        further risk by a visible refusal.<br><br>
        The only signal is the <b>esphome.sdc1_duress</b> event. Build a silent
        automation on it: a notification, a camera snapshot, a call. <b>Do not</b>
        make it announce itself at the door.
      </div>
      <ul>${rows}</ul>`;

    this._root.querySelectorAll("[data-toggle]").forEach((b) =>
      b.addEventListener("click", () => {
        const n = b.getAttribute("data-toggle");
        const to = b.getAttribute("data-to") === "1";
        if (to && !window.confirm(
              "Mark “" + n + "” as a duress credential?\n\n" +
              "Their unlocks will look completely normal, but each one will also " +
              "raise esphome.sdc1_duress.")) return;
        this.call("set_duress", { person_name: n, enabled: to });
      })
    );
  }
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

// Names are user-supplied, so they cannot go straight into a CSS selector.
function cssId(name) {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

function hourSelect(idBase, value, max) {
  const parts = [];
  for (let h = 0; h <= max; h++) {
    parts.push(
      '<option value="' + h + '"' + (h === value ? " selected" : "") + ">" +
      pad2(h) + ":00</option>"
    );
  }
  const id = idBase.split("-")[0] + "-" + cssId(idBase.slice(idBase.indexOf("-") + 1));
  return '<select id="' + id + '">' + parts.join("") + "</select>";
}

customElements.define("sdc1-schedule-card", Sdc1ScheduleCard);
customElements.define("sdc1-duress-card", Sdc1DuressCard);

window.customCards.push(
  {
    type: "sdc1-schedule-card",
    name: "SDC-1 Access Hours",
    description: "Restrict each enrolled person to an hours window.",
    preview: true,
    documentationURL: "https://github.com/deanex-international/sdc-1",
  },
  {
    type: "sdc1-duress-card",
    name: "SDC-1 Duress",
    description: "Mark credentials that unlock normally but raise a silent alarm.",
    preview: true,
    documentationURL: "https://github.com/deanex-international/sdc-1",
  }
);

console.info(`%c SDC-1 CARD %c ${VERSION} `,
  "background:#1c2b3a;color:#fff;border-radius:3px 0 0 3px;padding:1px 4px",
  "background:#03a9f4;color:#fff;border-radius:0 3px 3px 0;padding:1px 4px");
