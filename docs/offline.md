# Offline play — how it works and what to do

Working instructions (kenli F-007 T04). Checked so far only in desktop Chromium on Linux (local
probes); **not yet confirmed on a physical iPad** (that check is F-007 T06). Contract: dnd5
`docs/features/F-007-offline-packs/contracts/offline.md` §5, `local-copy.md`.

## What "prepared" means

Settings → **Offline play** prepares one character or one encounter for play without a
connection, on **this device and this browser profile** only:

1. **This version of the app** — its own files kept by its service worker. Preparation registers
   only the version you are running, checks every file and restores missing or damaged ones of
   that same version ("Prepare offline" again is the retry). The first time, the page is not yet
   controlled by it: the panel says **Reload to finish**; reload once.
2. **The exact packs** the character (or the encounter's world and every party member) plays
   with, stored on the device and checked by hash. A character without its own pins plays on the
   campaign's packs (Settings → content): preparation reads each of them whole from the server,
   stores it and remembers their exact versions for **these** settings. From then on the campaign
   catalog (play, Compendium, exports, the local copy) uses exactly those versions from the device,
   without trying the server — also when the server later offers other files. Preparing again keeps
   those versions (it only restores one of them when the server still has identical bytes). Changing the
   campaign's packs or sources makes that preparation unused (prepare again); switching back makes
   it used again. Nothing picks "the latest installed".
3. **Saved data** — the character, its history head and the settings saved without an error or a
   conflict. An unsaved change, a failed save or a change in another tab is never "ready".

The status is **Ready offline** only when all of it holds; otherwise the list says what is
missing, damaged, waiting or failed. An encounter is ready only when its world and every party
member are; one ready character says nothing about any other.

A pack the device doesn't have in the exact version (e.g. imported elsewhere) is **not**
downloaded by preparation and never replaced by another version: bring it with **Import…** (its
transfer file or URL), then check again. A pack stored with damaged bytes is shown as damaged and
left out; the prepared binding stays (the game says "unavailable" rather than using other bytes).

## Install first, then prepare (iPad)

- An app added to the Home Screen and the same site in a Safari tab keep **separate data**. Install
  the app from its icon first, open it **from the icon**, and prepare there.
- Installing does not copy anything from Safari, and preparing in the app does not prepare Safari
  (nor the other way round).

## Moving a character with its whole history (local copy)

- Source (e.g. a Safari tab with the character): Characters → **Local copy with state and
  history** → save the file. A character that plays on the campaign's packs must first be prepared
  **in the source** (Settings → Offline play) — otherwise the export says the campaign context is
  not prepared.
- Target (the installed app, online): Characters → **Load local copy** → the file → **Create**. It
  becomes a new, separate character; then **prepare it in the target** (Settings → Offline play).
- A copy is one moment, not a sync: play continued in the source doesn't reach the copy.

## Storage protection and limits

- Preparation asks the browser to keep this site's storage (`navigator.storage.persist()`); the
  answer is shown apart: *granted* lowers the chance that the browser clears the data, *denied* or
  *not available* doesn't make a prepared character less ready. **Neither is a backup**: deleting
  the app, clearing website data or the device can remove everything. Keep local copies of
  important characters elsewhere (Files, another device).
- There is no server backup or sync. If the device's storage is lost, nothing can be rebuilt —
  history included.
- A full storage or a cancelled/failed preparation keeps everything that was there (characters,
  history, packs); try again later or free space.
- A local copy file is limited to 20 MiB. Each app version keeps about 1.7 MB of files; old versions
  are not cleaned up yet.

## Offline behaviour

- With the app prepared and the server unreachable: the app opens from its own files, play saves
  on the device, history continues. New URLs (imports from a library, other sites) need a
  connection and say so.
- Updates to a newer app version are never applied by themselves (a later step adds an explicit
  update with your consent). If the app finds an unfinished update at start, it opens without
  changing data and asks you to close every window of the app and open it again.

## Checks (developers)

```bash
npx vitest run tests/offline tests/components/offline-panel.test.tsx
bun scripts/release.ts --base /dnd/ --out /tmp/rel
npx tsx scripts/f007-local-copy-seed.ts > /tmp/seed.json
node scripts/f007-readiness-probe.mjs --release /tmp/rel --seed /tmp/seed.json --out /tmp/r.json
```
