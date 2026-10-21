/**
 * kenli F-007 T05: the admission gate for mutations (contract offline.md §7.3). One owner:
 * every entry point that changes game data — documents, history days, settings, portraits, the
 * F-008 import, the local copy (export, commit, Undo/Redo of its import), the offline preparation
 * — enters through `admission.guard(entry, fn, refused)`. While the gate is closed (an update is
 * being agreed, this page is frozen for one, or the page must reload after `controllerchange`)
 * a new mutation is refused at once with `update_in_progress`: nothing runs, nothing is written,
 * no history entry. Mutations already admitted run to their end; `drain()` waits for them.
 *
 * Entry points are the outer operations only (a guarded operation calling another one uses the
 * inner, unguarded function), so there is no nesting and no counter to unwind on refusal.
 *
 * `holds` are the open UI states that must end before an update (an import's preview, a rest's
 * preview, a build change's preview, preparation); `blockers()` adds the data states (a pending
 * encounter decision, a roll still in its change window) and, after `drain()` and `flushNow()`,
 * `savedReasons()` says whether everything is saved: no failed save, no conflict, no unsaved
 * entry, day, document or setting (a resolved `flushNow()` alone proves nothing).
 */

import { create } from "zustand";

export type BlockerCode =
  | "import_open"
  | "rest_preview_open"
  | "build_preview_open"
  | "decision_pending"
  | "reroll_window_open"
  | "save_failed"
  | "save_conflict"
  | "unsaved"
  | "operation_in_flight"
  | "prepare_in_progress";

export interface Reason {
  readonly code: string;
  readonly detail: string;
}

export const UPDATE_IN_PROGRESS = "update_in_progress";

interface GateState {
  /** Why mutations are refused now (`null`: open). */
  readonly closed: { readonly by: string; readonly request_id: string | null } | null;
  /** Open UI states that block an update (code → count). */
  readonly holds: Readonly<Record<string, number>>;
}

export const useAdmission = create<GateState>()(() => ({ closed: null, holds: {} }));

let inFlight = 0;
let idle: (() => void)[] = [];
const settle = () => {
  if (inFlight > 0) return;
  const waiting = idle;
  idle = [];
  for (const w of waiting) w();
};

export const admission = {
  /** Whether a new mutation would be refused now. */
  isClosed: (): boolean => useAdmission.getState().closed !== null,

  /**
   * Run an outer mutation, or refuse it (`refused()`, nothing else runs) while the gate is closed.
   * The check and the count happen synchronously, before the operation's first await.
   */
  guard<T>(_entry: string, fn: () => T | Promise<T>, refused: () => T): Promise<T> {
    if (useAdmission.getState().closed) return Promise.resolve(refused());
    inFlight++;
    let result: T | Promise<T>;
    try {
      result = fn();
    } catch (error) {
      inFlight--;
      settle();
      return Promise.reject(error);
    }
    return Promise.resolve(result).finally(() => {
      inFlight--;
      settle();
    });
  },

  /** A synchronous mutation (history days, settings): refused while closed. */
  allowed: (): boolean => !useAdmission.getState().closed,

  close(by: string, requestId: string | null): void {
    useAdmission.setState({ closed: { by, request_id: requestId } });
  },

  /** Open again — only for the same request (a late `thaw` of another request opens nothing). */
  open(requestId: string | null): boolean {
    const c = useAdmission.getState().closed;
    if (!c || c.by === "reload" || c.request_id !== requestId) return false;
    useAdmission.setState({ closed: null });
    return true;
  },

  /** Wait until no admitted mutation is running (or the time is up: `false`). */
  drain(timeoutMs = 10_000): Promise<boolean> {
    if (inFlight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        idle = idle.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      idle.push(done);
    });
  },

  /** Mutations admitted and still running (tests, the update dialog). */
  inFlight: (): number => inFlight,

  /** An open UI state that blocks an update; call the result when it closes. */
  hold(code: BlockerCode): () => void {
    useAdmission.setState((s) => ({ holds: { ...s.holds, [code]: (s.holds[code] ?? 0) + 1 } }));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      useAdmission.setState((s) => {
        const n = (s.holds[code] ?? 1) - 1;
        const holds = { ...s.holds };
        if (n > 0) holds[code] = n;
        else delete holds[code];
        return { holds };
      });
    };
  },

  holds: (): Reason[] =>
    Object.keys(useAdmission.getState().holds).map((code) => ({ code, detail: "" })),
};

/** Tests: everything open, nothing held or running. */
export function resetAdmission(): void {
  inFlight = 0;
  settle();
  useAdmission.setState({ closed: null, holds: {} });
}
