/**
 * kenli F-002 T08 (durability): the autosave's delay runs from the FIRST unsaved change.
 *  - Steady play (a change every 80 ms for over a second) is saved WHILE it goes on; the old
 *    re-armed debounce saved nothing until the play stopped.
 *  - Leaving the page while a change isn't written yet asks first (`beforeunload` is prevented);
 *    once it is written, leaving asks nothing.
 *  - Hiding the page (another app, a closed lid) saves at once, without waiting for the delay.
 * Real store, autosave and fake IndexedDB; an SRD character.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/persistence/db";
import { useDocuments } from "../../src/store/documents";
import { rogue } from "../fixtures/characters";
import { installTestEngine } from "../helpers/app";
import { addCharacter, Installations, type Loose } from "../localCopy/helpers";

installTestEngine(6);
const inst = new Installations();
beforeEach(async () => {
  await inst.open(`AS-${Math.random().toString(36).slice(2)}`);
});
afterAll(() => inst.close());

const stored = async (id: string) => ((await (await db()).get("characters", id)) as Loose)?.rev;
const leaving = () => {
  const ev = new Event("beforeunload", { cancelable: true });
  dispatchEvent(ev);
  return ev.defaultPrevented;
};

describe("the autosave's delay runs from the first unsaved change", () => {
  it("steady play is saved while it goes on, not only after it stops", async () => {
    const id = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    await new Promise((r) => setTimeout(r, 600));
    const before = await stored(id);
    const end = Date.now() + 1200;
    let savedDuring = false;
    for (let hp = 1; Date.now() < end; hp++) {
      const r = await useDocuments
        .getState()
        .playAction(id, { type: "set_temp_hp", amount: hp } as Loose);
      expect(r.ok).toBe(true);
      if ((await stored(id)) !== before) savedDuring = true;
      await new Promise((r2) => setTimeout(r2, 80));
    }
    expect(savedDuring).toBe(true);
  }, 30_000);

  it("leaving with a change not written asks first; once written, it doesn't", async () => {
    const id = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    await new Promise((r) => setTimeout(r, 600));
    expect(leaving()).toBe(false);
    const r = await useDocuments.getState().playAction(id, { type: "damage", amount: 2 } as Loose);
    expect(r.ok).toBe(true);
    expect(leaving()).toBe(true);
    await new Promise((r2) => setTimeout(r2, 800));
    expect(leaving()).toBe(false);
  }, 30_000);

  it("hiding the page saves at once", async () => {
    const id = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    await new Promise((r) => setTimeout(r, 600));
    const before = await stored(id);
    const r = await useDocuments.getState().playAction(id, { type: "damage", amount: 1 } as Loose);
    expect(r.ok).toBe(true);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    dispatchEvent(new Event("visibilitychange"));
    await new Promise((r2) => setTimeout(r2, 100)); // well inside the 300 ms delay
    expect(await stored(id)).not.toBe(before);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  }, 30_000);
});
