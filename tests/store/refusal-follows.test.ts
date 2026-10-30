/**
 * kenli F-011 T04 (contracts/changes.md §5.1, §5.6): the runtime entry check of a refusal's
 * `links.follows` — exactly the local roll for a refused follow-up (late Advantage, Heroic reroll),
 * nothing for any other command, never an outside (`ext:`) op. A violation is refused at capture
 * (an app bug), so no saved journal holds an entry a copy's whole-journal check would refuse.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { checkEntry } from "../../src/import/localCopy/format";
import { type EntryDraft, useHistory } from "../../src/store/history";

beforeEach(() => useHistory.getState().hydrate([]));

const draft = (command: string, follows: string | null): EntryDraft => ({
  record_id: "c-1",
  name: "Wren",
  gen: 0,
  operation_id: `op-${Math.random().toString(36).slice(2)}`,
  kind: "refused",
  commit: false,
  source: "sheet",
  request: { type: "x" },
  messages: [{ code: "resource_empty", params: {}, text: "No slot" }] as never,
  follows,
  refusal: { command, label: "Tried" } as never,
});
const capture = (d: EntryDraft) => () => useHistory.getState().capture([d]);

describe("a refusal's follows at capture", () => {
  it("a follow-up follows its local roll; another command follows nothing: captured, and valid in a copy", () => {
    const [late] = useHistory.getState().capture([draft("late_advantage", "op-roll")]);
    expect(late?.links.follows).toBe("op-roll");
    const [cast] = useHistory.getState().capture([draft("sheet_cast", null)]);
    expect(cast?.links.follows).toBeNull();
    for (const e of [late, cast]) expect(() => checkEntry(e, "e")).not.toThrow();
  });

  it("a follow-up without its roll, another command with one, an outside op: refused, nothing captured", () => {
    expect(capture(draft("heroic_reroll", null))).toThrow(/history_refusal_invalid/);
    expect(capture(draft("sheet_use", "op-roll"))).toThrow(/history_refusal_invalid/);
    expect(capture(draft("late_advantage", "ext:i1:op-roll"))).toThrow(/history_refusal_invalid/);
    expect(Object.keys(useHistory.getState().entries)).toHaveLength(0);
    expect(useHistory.getState().meta["c-1"]).toBeUndefined();
  });
});
