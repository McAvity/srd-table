/**
 * Play actions from one part of the sheet: send them through the store (the engine's
 * `applyAction`; a roll by hand, `rollByHand`), and keep the refusal reasons to show right there.
 */

import { useState } from "react";
import type { PlayAction, RollWhat } from "srd-rules-engine";
import { useDocuments } from "@/store/documents";

export function usePlay(id: string) {
  const playAction = useDocuments((s) => s.playAction);
  const rollByHand = useDocuments((s) => s.rollByHand);
  const [reasons, setReasons] = useState<readonly string[] | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(send: () => Promise<{ ok: boolean; reasons?: readonly string[] }>) {
    setBusy(true);
    try {
      const result = await send();
      setReasons(result.ok ? null : (result.reasons ?? null));
      return result.ok;
    } finally {
      setBusy(false);
    }
  }
  const act = (action: PlayAction | readonly PlayAction[]) => run(() => playAction(id, action));
  const roll = (what: RollWhat) => run(() => rollByHand(id, what));
  return { act, roll, reasons, busy, clear: () => setReasons(null) };
}
