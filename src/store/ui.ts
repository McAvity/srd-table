/**
 * UI state that isn't a document: toasts (setter and play notes), dice results on screen, a
 * combatant a result points at (the encounter screen selects it), and the view (GM or a player). Nothing here is persisted except the view, per browser.
 */

import type { D20TestResult, RolledDamage, RollResult } from "srd-rules-engine";
import { create } from "zustand";
import type { RolledResult } from "@/engine/facade";

export type ToastTone = "info" | "warning" | "error";

export interface Toast {
  readonly id: number;
  readonly tone: ToastTone;
  readonly title?: string;
  readonly lines: readonly string[];
}

/** A roll to show: an encounter action's result, or a free roll. */
export type DiceShown =
  | {
      readonly id: number;
      readonly kind: "action";
      readonly who: string;
      readonly result: RolledResult;
    }
  | { readonly id: number; readonly kind: "roll"; readonly who: string; readonly roll: RollResult }
  | {
      readonly id: number;
      readonly kind: "test";
      readonly who: string;
      readonly test: D20TestResult;
    }
  | {
      readonly id: number;
      readonly kind: "damage";
      readonly who: string;
      readonly damage: RolledDamage;
    };

type DiceInput =
  | { readonly kind: "action"; readonly who: string; readonly result: RolledResult }
  | { readonly kind: "roll"; readonly who: string; readonly roll: RollResult }
  | { readonly kind: "test"; readonly who: string; readonly test: D20TestResult }
  | { readonly kind: "damage"; readonly who: string; readonly damage: RolledDamage };

export type Role =
  | { readonly kind: "gm" }
  | { readonly kind: "player"; readonly character: string | null };

interface UiState {
  toasts: readonly Toast[];
  dice: readonly DiceShown[];
  role: Role;
  /** A combatant a result was clicked for: the encounter screen selects it, then clears this. */
  focus: string | null;
  /**
   * The table and the character this viewer opened last: the top bar's Table and Characters open
   * them (a per-viewer convenience, remembered in this browser).
   */
  lastOpened: LastOpened;
  toast(lines: readonly string[], tone?: ToastTone, title?: string): void;
  dismissToast(id: number): void;
  showDice(items: readonly DiceInput[]): void;
  dismissDice(id: number): void;
  focusCombatant(id: string | null): void;
  setRole(role: Role): void;
  /** A table or a character was opened. */
  opened(kind: keyof LastOpened, id: string): void;
}

export interface LastOpened {
  readonly encounter: string | null;
  readonly character: string | null;
}

let nextId = 1;
const ROLE_KEY = "srd-table.role";
const LAST_KEY = "srd-table.last-opened";

function savedLastOpened(): LastOpened {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<Record<keyof LastOpened, unknown>>) : {};
    return {
      encounter: typeof v.encounter === "string" ? v.encounter : null,
      character: typeof v.character === "string" ? v.character : null,
    };
  } catch {
    return { encounter: null, character: null };
  }
}

function savedRole(): Role {
  try {
    const raw = localStorage.getItem(ROLE_KEY);
    if (raw) {
      const role = JSON.parse(raw) as Role;
      if (role.kind === "gm" || role.kind === "player") return role;
    }
  } catch {
    // Storage blocked or garbled: the default is fine.
  }
  return { kind: "gm" };
}

export const useUi = create<UiState>()((set) => ({
  toasts: [],
  dice: [],
  role: savedRole(),
  focus: null,
  lastOpened: savedLastOpened(),
  toast(lines, tone = "info", title) {
    if (!lines.length) return;
    const toast: Toast = { id: nextId++, tone, lines, ...(title ? { title } : {}) };
    set((s) => ({ toasts: [...s.toasts.slice(-4), toast] }));
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  showDice(items) {
    if (!items.length) return;
    const shown = items.map((item) => ({ ...item, id: nextId++ }) as DiceShown);
    set((s) => ({ dice: [...s.dice, ...shown].slice(-6) }));
  },
  dismissDice(id) {
    set((s) => ({ dice: s.dice.filter((d) => d.id !== id) }));
  },
  focusCombatant(focus) {
    set({ focus });
  },
  setRole(role) {
    try {
      localStorage.setItem(ROLE_KEY, JSON.stringify(role));
    } catch {
      // Not remembered: still applied for this session.
    }
    set({ role });
  },
  opened(kind, id) {
    set((s) => {
      if (s.lastOpened[kind] === id) return s;
      const lastOpened = { ...s.lastOpened, [kind]: id };
      try {
        localStorage.setItem(LAST_KEY, JSON.stringify(lastOpened));
      } catch {
        // Not remembered: still used for this session.
      }
      return { lastOpened };
    });
  },
}));
