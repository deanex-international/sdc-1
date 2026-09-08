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
 *   type: custom:sdc1-card
 *   prefix: sdc_1      # optional; entity_id prefix, default sdc_1
 */

const VERSION = "1.0.0";

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
  peopleCount:     { domain: "sensor",        re: /_registered_people$/ },
  dbUsage:         { domain: "sensor",        re: /_database_usage$/ },
  lockoutStatus:   { domain: "sensor",        re: /_lockout_status$/ },
  lockoutActive:   { domain: "binary_sensor", re: /_lockout_active$/ },
  enrollStatus:    { domain: "sensor",        re: /_enrollment_status$/ },
  enrollName:      { domain: "text",          re: /_enroll_name$/ },
  fpEnroll:        { domain: "button",        re: /_fp_start_enrollment$/ },
  faceEnroll:      { domain: "button",        re: /_face_start_enrollment$/ },
  nfcEnroll:       { domain: "button",        re: /_nfc_link_next_tag$/ },
  cancelEnroll:    { domain: "button",        re: /_cancel_enrollment$/ },
  clearLockout:    { domain: "button",        re: /_clear_lockout$/ },
};

class Sdc1Card extends HTMLElement {
  constructor() {
    super();
    this._built = false;
    this._roster = null;       // [{n, fp, fc, nfc}] from the device event
    this._unsub = null;
    this._primed = false;
    this._busy = false;
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
      const svc = this._config.prefix + "_publish_roster";
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
    const txt = this._val("people", "");
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
    this._call("esphome", this._config.prefix + "_delete_person", { person_name: name });
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
    const people = this._people();
    const truncated = /\+\d+ more/.test(this._val("people", ""));
    const dis = this._busy ? "disabled" : "";

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
      : `<div class="empty">Nobody is enrolled yet.</div>`;

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

console.info(`%c SDC-1 CARD %c ${VERSION} `,
  "background:#1c2b3a;color:#fff;border-radius:3px 0 0 3px;padding:1px 4px",
  "background:#03a9f4;color:#fff;border-radius:0 3px 3px 0;padding:1px 4px");
