# SDC-1 — distribution

Everything a customer touches. Copy the **contents of this folder** into a
separate **public** repo (`deanex-international/sdc-1`) and push. The firmware
source stays in the private repo; only this folder ships.

```
sdc-1/  (public)
├── hacs.json              HACS reads this at the repo root
├── sdc1-card.js           all three dashboard cards, one file
├── index.html             browser installer, served by GitHub Pages
├── README.md              becomes the HACS description
├── firmware/
│   ├── manifest.json      read by the update entity AND the browser installer
│   ├── SDC1-v5.9.0.ota.bin
│   └── SDC1-v5.9.0.factory.bin
└── blueprints/automation/deanex/
    ├── sdc1_doorbell.yaml
    └── sdc1_access_alert.yaml
```

The repo must be public: the device fetches `manifest.json` itself,
unauthenticated, and HACS and the blueprint importer do the same.

---

## What the customer does

1. **Flash.** Opens `https://deanex-international.github.io/sdc-1/`, plugs in
   USB, clicks Install. ESP Web Tools flashes and then offers Wi-Fi setup,
   because the firmware has `improv_serial` enabled.
2. **Add to Home Assistant.** HA discovers it over mDNS and offers to add it.
   With keyless `api: encryption:` the key is generated and stored on first
   connection — nothing to type.
3. **Install the card.** HACS → Custom repositories → `deanex-international/sdc-1`,
   category *Dashboard*. Then *Add card* → *SDC-1 Access Control*.
4. **Done.** Enrolling, deleting and the roster all live in that one card.

No YAML, no helpers, no template sensors.

---

## Releasing a new firmware version

```bash
# from PowerShell, not Git Bash -- see the note in tools/release.py
python tools/release.py --summary "Adds lockdown scheduling"
```

That bumps nothing on its own: it reads `esphome.project.version` from
`SDC1.yaml`, compiles, copies both binaries into `distribution/firmware/`, and
writes `manifest.json` with a fresh MD5. Then copy `distribution/` into the
public repo and push.

Devices poll the manifest every 6 hours and surface an **Update** entity in
Home Assistant when `version` is newer than their own
`esphome.project.version`. The customer clicks Update; the device downloads the
`.ota.bin`, verifies the MD5 from the manifest, and reboots.

Old binaries are not needed for devices to update: a device always reads the
current manifest and jumps straight to whatever version it names, however many
releases it skipped. Keep the last two or three only so you can hand-roll a
device back by pointing a manifest at an older file.

---

## Why this shape

**The card, not a HACS "package".** HACS distributes integrations, dashboard
plugins, themes and blueprints — it does not distribute helpers or automations.
A single dashboard plugin removes the need for them: the card subscribes to the
device's `esphome.sdc1_roster` event for the enrolled list and calls
`esphome.<device>_delete_person` directly, so there is no `input_select` to
create and no automation to keep in sync.

`homeassistant/sdc1-package.yaml` in the private repo does the same job with
plain YAML helpers. It is the fallback for anyone who does not want HACS; the
card supersedes it.

**One manifest, two consumers.** `manifest.json` carries both an `ota` object
(ESPHome's update platform: `path` + `md5`) and a `parts` array (ESP Web Tools:
`path` + `offset`). Same file for in-place updates and first-time flashing.

**`chipFamily` must be exactly `ESP32-C3`.** The device compares it against its
own `ESPHOME_VARIANT` and silently ignores builds that do not match.

---

## The dashboard cards moved

They live in their own repository so they can be released independently:
**https://github.com/deanex-international/sdc1-card**

A card fix then ships in seconds without rebuilding firmware, and without
offering every deployed device an update whose binary differs only in a version
string. Customers add that repository to HACS, not this one.


## Card configuration

The card finds its entities by scanning for an entity-ID prefix, which survives
the sub-device grouping added in firmware v5.6.0:

```yaml
type: custom:sdc1-card
prefix: sdc_1        # optional; default sdc_1
title: Front Door    # optional
```

If your device is named something else, set `prefix` to match. Any individual
entity can also be pinned explicitly, e.g. `lock: lock.front_door`. The card
hides whatever it cannot find rather than erroring, so a partially configured
device still renders.
