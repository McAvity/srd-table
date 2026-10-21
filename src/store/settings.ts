/**
 * Campaign settings: a small document of its own (IndexedDB), not an engine document. Packs and
 * sources configure the catalog; decision modes say who answers decisions after a roll.
 */

import { create } from "zustand";
import { engine } from "@/engine/client";
import { configureCampaign } from "@/offline/campaign";

export type DecisionMode = "ask" | "auto";
/**
 * How a combatant's actions are played: `auto`, the engine rolls and resolves; `manual`, by
 * hand: the engine rolls the dice and the app pays the costs, the outcome is applied with effects.
 */
export type PlayWay = "auto" | "manual";
export const PLAY_WAYS: readonly PlayWay[] = ["auto", "manual"];
/** `system` follows the device (Mat when light, Felt when dark). */
export type Theme = "system" | "mat" | "felt";

export interface CampaignSettings {
  readonly version: 1;
  /** Content packs in load order (the SRD first), served at `content/<id>/`. */
  readonly packs: readonly string[];
  /** Sources the campaign allows; `null`: every source of the loaded packs. */
  readonly sources: readonly string[] | null;
  /**
   * Who answers decisions after a roll, for new combatants. `ask` stops the action for the player
   * (or the GM, for monsters); `auto` takes the engine's recommendation. A combatant's own mode
   * is changed in the encounter (`set_decisions`, selection panel).
   */
  readonly character_decisions: DecisionMode;
  readonly monster_decisions: DecisionMode;
  /**
   * How actions are played by default, for characters and for monsters; the GM changes it per
   * combatant in the encounter (selection panel), and any action can still be played the other way.
   */
  readonly character_play: PlayWay;
  readonly monster_play: PlayWay;
  readonly theme: Theme;
  readonly locale: string;
  /** Dev: fix the dice seed so a bug can be replayed (`null`: random). */
  readonly dev_seed: number | null;
  /** Quick-bar favourites by character (or monster) id: keys of the options' actions. */
  readonly favorites: Readonly<Record<string, readonly string[]>>;
}

export const DEFAULT_SETTINGS: CampaignSettings = {
  version: 1,
  packs: ["srd-5.2.1"],
  sources: null,
  character_decisions: "ask",
  monster_decisions: "ask",
  character_play: "auto",
  monster_play: "auto",
  theme: "system",
  locale: "en",
  dev_seed: null,
  favorites: {},
};

interface SettingsState {
  settings: CampaignSettings;
  update(patch: Partial<Omit<CampaignSettings, "version">>): void;
  toggleFavorite(character: string, label: string): void;
  replace(settings: CampaignSettings): void;
  /** Change the packs and sources: the engine rebuilds its catalog; every view recomputes. */
  setContent(packs: readonly string[], sources: readonly string[] | null): Promise<void>;
  /** Fix the dice seed (dev), or go back to a random one. */
  setDevSeed(seed: number | null): Promise<void>;
}

export const useSettings = create<SettingsState>()((set) => ({
  settings: DEFAULT_SETTINGS,
  update(patch) {
    set((s) => ({ settings: { ...s.settings, ...patch } }));
  },
  toggleFavorite(character, label) {
    set((s) => {
      const current = s.settings.favorites[character] ?? [];
      const next = current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label];
      return {
        settings: { ...s.settings, favorites: { ...s.settings.favorites, [character]: next } },
      };
    });
  },
  replace(settings) {
    set({ settings });
  },
  async setContent(packs, sources) {
    // kenli F-007 T04: other settings leave a prepared context unused (never "the latest
    // installed"); the same settings again use it again.
    await configureCampaign({ packs, sources });
    set((s) => ({ settings: { ...s.settings, packs, sources } }));
  },
  async setDevSeed(seed) {
    await engine().setSeed(seed);
    set((s) => ({ settings: { ...s.settings, dev_seed: seed } }));
  },
}));

/** Read a stored settings object, keeping known fields and filling defaults. */
/** Settings saved before the Mat and Marker look had `parchment` (light) and `night` (dark). */
function readTheme(v: unknown): Theme {
  if (v === "mat" || v === "parchment") return "mat";
  if (v === "felt" || v === "night") return "felt";
  return "system";
}

function way(v: unknown): PlayWay {
  return v === "manual" ? "manual" : "auto";
}

export function readSettings(raw: unknown): CampaignSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS;
  const r = raw as Partial<Record<keyof CampaignSettings, unknown>>;
  const mode = (v: unknown, d: DecisionMode): DecisionMode => (v === "ask" || v === "auto" ? v : d);
  const strings = (v: unknown) =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
  return {
    version: 1,
    packs: strings(r.packs) ?? DEFAULT_SETTINGS.packs,
    sources: r.sources === null ? null : (strings(r.sources) ?? null),
    character_decisions: mode(r.character_decisions, DEFAULT_SETTINGS.character_decisions),
    monster_decisions: mode(r.monster_decisions, DEFAULT_SETTINGS.monster_decisions),
    character_play: way(r.character_play),
    monster_play: way(r.monster_play),
    theme: readTheme(r.theme),
    locale: typeof r.locale === "string" ? r.locale : "en",
    dev_seed: typeof r.dev_seed === "number" && Number.isInteger(r.dev_seed) ? r.dev_seed : null,
    favorites:
      typeof r.favorites === "object" && r.favorites !== null
        ? Object.fromEntries(
            Object.entries(r.favorites as Record<string, unknown>).flatMap(([k, v]) => {
              const list = strings(v);
              return list ? [[k, list]] : [];
            }),
          )
        : {},
  };
}
