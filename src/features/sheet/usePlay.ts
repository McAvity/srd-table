/**
 * Play actions from one part of the sheet: send them through the store (the engine's
 * `applyAction`; a roll by hand, `rollByHand`), and keep the refusal reasons to show right there.
 */

import { useState } from "react";
import type { PlayAction, RollWhat } from "srd-rules-engine";
import { useDocuments } from "@/store/documents";
import { type DeclaredLucky, luckySpent, type RecordVersion } from "@/store/rolls";

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
  /** With `at`, only on the record as it was then (a dialog's preview), else refused. */
  const act = (action: PlayAction | readonly PlayAction[], at?: RecordVersion) =>
    run(() => playAction(id, action, at));
  /** With `lucky`, the declared luck-style use is spent with the roll, then cleared. */
  const roll = (what: RollWhat, lucky?: DeclaredLucky) =>
    run(async () => {
      const result = await rollByHand(id, what, lucky);
      if (result.ok && lucky) luckySpent(id);
      return result;
    });
  return { act, roll, reasons, busy, clear: () => setReasons(null) };
}

/** Busy state and the engine's reasons of the last refused call, for any store call. */
export function usePlayResult() {
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
  return { run, reasons, busy };
}
