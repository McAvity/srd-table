/**
 * Derived views: TanStack Query over the facade, keyed by the document's revision (not a deep
 * hash), so a view is recomputed exactly when its document changes. The previous view stays on
 * screen while the next one computes. Components read through these hooks, never the facade.
 */

import { keepPreviousData, QueryClient, useQuery } from "@tanstack/react-query";
import type { AreaRequest, Encounter, EncounterAction, Message, TableName } from "srd-rules-engine";
import { engine } from "@/engine/client";
import { type ContentContext, contextKey } from "@/lib/canonical";
import { db } from "@/persistence/db";
import { characterKeysOf, partyOf, useDocuments } from "@/store/documents";
import { useLocale } from "@/store/locale";
import { useSettings } from "@/store/settings";
import { useScopeContent } from "./scope";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: 5 * 60_000,
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
  });
}

/**
 * Changes when the catalog changes (packs, sources) or the language engine texts are rendered in:
 * every derived view depends on both.
 */
function useContentKey(): string {
  const { packs, sources } = useSettings((s) => s.settings);
  const locale = useLocale((s) => s.applied);
  return `${packs.join(",")}|${sources?.join(",") ?? "*"}|${locale}`;
}

/**
 * A document's content key: its own packs when it's pinned to them (kenli F-008), else the
 * campaign's. Two documents on two versions of a pack never share a cached view.
 */
function useDocumentContentKey(content: ContentContext | undefined): string {
  const campaign = useContentKey();
  const locale = useLocale((s) => s.applied);
  return content ? `${contextKey(content)}|${locale}` : campaign;
}

function useCharacterContent(id: string | undefined): ContentContext | undefined {
  return useDocuments((s) => (id ? s.characters[id]?.content : undefined));
}

function useRev(id: string | undefined): number {
  return useDocuments((s) => (id ? (s.revs[id] ?? 0) : 0));
}

/** The builder's view of a character's build (`evaluate`). */
export function useBuildView(id: string) {
  const own = useCharacterContent(id);
  const content = useDocumentContentKey(own);
  const rev = useRev(id);
  const build = useDocuments((s) => s.characters[id]?.build);
  return useQuery({
    queryKey: ["build", id, rev, content],
    queryFn: () => engine().evaluate(build as NonNullable<typeof build>, own),
    enabled: build !== undefined,
    placeholderData: keepPreviousData,
  });
}

/** What each option of a builder choice would change on the sheet (`previewOption`). */
export function useOptionPreviews(id: string | undefined, choiceKey: string) {
  const own = useCharacterContent(id);
  const content = useDocumentContentKey(own);
  const rev = useRev(id);
  const build = useDocuments((s) => (id ? s.characters[id]?.build : undefined));
  return useQuery({
    queryKey: ["option-previews", id, choiceKey, rev, content],
    queryFn: () => engine().optionPreviews(build as NonNullable<typeof build>, choiceKey, own),
    enabled: build !== undefined,
    placeholderData: keepPreviousData,
  });
}

/**
 * Stored engine messages (a combat log, a pending decision's question) in the current language,
 * list by list; `key` identifies the lists (they're compared by it, not deeply). While rendering,
 * or for a list without messages, callers show the stored English text.
 */
export function useRenderedMessages(key: string, lists: readonly (readonly Message[])[]) {
  const content = useContentKey();
  return useQuery({
    queryKey: ["messages", key, content],
    queryFn: () => engine().renderMessages(lists),
    placeholderData: keepPreviousData,
  });
}

/** The items a magic item can be made from (`magicItemBases`), in a character's or the scope's content. */
export function useMagicItemBases(magicItemId: string | null, characterId?: string) {
  const ofCharacter = useCharacterContent(characterId);
  const inScope = useScopeContent();
  const own = characterId ? ofCharacter : inScope;
  const content = useDocumentContentKey(own);
  return useQuery({
    queryKey: ["magic-bases", magicItemId, content],
    queryFn: () => engine().magicItemBases(magicItemId as string, own),
    enabled: magicItemId !== null,
  });
}

/** What `take_starting_equipment` would add, asked only while it isn't taken (`enabled`). */
export function useStartingEquipment(id: string, enabled: boolean) {
  const own = useCharacterContent(id);
  const content = useDocumentContentKey(own);
  const rev = useRev(id);
  const build = useDocuments((s) => s.characters[id]?.build);
  return useQuery({
    queryKey: ["starting-equipment", id, rev, content],
    queryFn: () => engine().startingEquipment(build as NonNullable<typeof build>, own),
    enabled: enabled && build !== undefined,
  });
}

/** The build as played today (`playBuild`): the options of "after a rest" choices today. */
export function usePlayBuildView(id: string) {
  const content = useDocumentContentKey(useCharacterContent(id));
  const rev = useRev(id);
  const record = useDocuments((s) => s.characters[id]);
  return useQuery({
    queryKey: ["play-build", id, rev, content],
    queryFn: () => {
      if (!record) throw new Error("no character");
      return engine().evaluatePlay(record.build, record.state, record.content);
    },
    enabled: record !== undefined,
    placeholderData: keepPreviousData,
  });
}

/** The play sheet (`computePlaySheet`) and the state's issues. */
export function usePlayView(id: string | undefined) {
  const content = useDocumentContentKey(useCharacterContent(id));
  const rev = useRev(id);
  const record = useDocuments((s) => (id ? s.characters[id] : undefined));
  return useQuery({
    queryKey: ["play", id, rev, content],
    queryFn: () => {
      if (!record) throw new Error("no character");
      return engine().playSheet(record.build, record.state, record.content);
    },
    enabled: record !== undefined,
    placeholderData: keepPreviousData,
  });
}

/**
 * The encounter's party: changes when the encounter or any of its characters changes, their
 * content included (each character plays on its own packs).
 */
function usePartyKey(encounterId: string): string {
  return useDocuments((s) => {
    const record = s.encounters[encounterId];
    if (!record) return "";
    return characterKeysOf(record.encounter)
      .map((key) => {
        const own = s.characters[key]?.content;
        return `${key}:${s.revs[key] ?? 0}:${own ? contextKey(own) : "-"}`;
      })
      .join(",");
  });
}

function useEncounterInputs(encounterId: string) {
  const record = useDocuments((s) => s.encounters[encounterId]);
  const partyKey = usePartyKey(encounterId);
  const rev = useRev(encounterId);
  const content = useDocumentContentKey(record?.content);
  return { record, key: [encounterId, rev, partyKey, content] as const };
}

/** Initiative order, HP, AC, conditions: what the tracker and the map show. */
export function useEncounterView(encounterId: string) {
  const { record, key } = useEncounterInputs(encounterId);
  return useQuery({
    queryKey: ["encounter", ...key],
    queryFn: () => {
      if (!record) throw new Error("no encounter");
      return engine().encounterView(
        record.encounter,
        partyOf(record.encounter, useDocuments.getState().characters),
        record.content,
      );
    },
    enabled: record !== undefined,
    placeholderData: keepPreviousData,
  });
}

/** What one combatant can do now (computed only for the combatant on screen). */
export function useCombatantOptions(encounterId: string, combatantId: string | null) {
  const { record, key } = useEncounterInputs(encounterId);
  return useQuery({
    queryKey: ["options", ...key, combatantId],
    queryFn: () => {
      if (!record || !combatantId) throw new Error("no combatant");
      const party = partyOf(record.encounter, useDocuments.getState().characters);
      return engine().combatantOptions(record.encounter, party, combatantId, record.content);
    },
    enabled: record !== undefined && combatantId !== null && record.encounter.pending === null,
    placeholderData: keepPreviousData,
  });
}

/** Would the engine take this action now (a dry run), for a control the options don't list. */
export function useActionCheck(encounterId: string, action: EncounterAction | null) {
  const { record, key } = useEncounterInputs(encounterId);
  return useQuery({
    queryKey: ["check", ...key, action],
    queryFn: () => {
      if (!record || !action) throw new Error("no action");
      const party = partyOf(record.encounter, useDocuments.getState().characters);
      return engine().checkAction(record.encounter, party, action, record.content);
    },
    enabled: record !== undefined && action !== null,
  });
}

/** Whose content a lookup uses: a character's (by record id), else the scope's. */
export interface Owner {
  readonly character?: string | null;
}
function useOwnerContent(owner: Owner | undefined): ContentContext | undefined {
  const scoped = useScopeContent();
  const record = useDocuments((s) =>
    owner?.character ? s.characters[owner.character] : undefined,
  );
  return owner?.character ? record?.content : scoped;
}

/**
 * Every entity of a catalog table, from the content in scope (a sheet's or builder's character,
 * the encounter's world, a combatant's own; the campaign's elsewhere: Compendium, Settings).
 */
export function useTable<T = unknown>(table: TableName, owner?: Owner) {
  const own = useOwnerContent(owner);
  const content = useDocumentContentKey(own);
  return useQuery({
    queryKey: ["table", table, content],
    queryFn: async () => (await engine().entries(table, own)) as readonly T[],
  });
}

export function useEntry<T = unknown>(table: TableName, id: string | null, owner?: Owner) {
  const own = useOwnerContent(owner);
  const content = useDocumentContentKey(own);
  return useQuery({
    queryKey: ["entry", table, id, content],
    queryFn: async () => (await engine().entry(table, id as string, own)) as T | null,
    enabled: id !== null,
  });
}

/** Catalog names by id for one table (`common` → `Common`). */
export function useNames(table: TableName, owner?: Owner): (id: string) => string {
  const { data } = useTable<{ id: string; name: string }>(table, owner);
  const names = new Map((data ?? []).map((e) => [e.id, e.name]));
  return (id) => names.get(id) ?? id;
}

/** Squares within `feet` of a combatant (reach or range on the map). */
export function useSquaresWithin(
  encounterId: string,
  combatantId: string | null,
  feet: number | null,
) {
  const { record, key } = useEncounterInputs(encounterId);
  return useQuery({
    queryKey: ["within", ...key, combatantId, feet],
    queryFn: () =>
      engine().squaresWithin(
        record?.encounter as Encounter,
        partyOf(record?.encounter as Encounter, useDocuments.getState().characters),
        combatantId as string,
        feet as number,
        record?.content,
      ),
    enabled: record !== undefined && combatantId !== null && feet !== null,
  });
}

/** What an area would cover if placed now: its squares and creatures (`previewArea`). */
export function useAreaPreview(encounterId: string, request: AreaRequest | null) {
  const { record, key } = useEncounterInputs(encounterId);
  return useQuery({
    queryKey: ["area", ...key, request],
    queryFn: () => {
      if (!record || !request) throw new Error("no area");
      const party = partyOf(record.encounter, useDocuments.getState().characters);
      return engine().previewArea(record.encounter, party, request, record.content);
    },
    enabled: record !== undefined && request !== null,
  });
}

/** Squares a combatant can end a move on now (`reachableSquares`). */
export function useReachable(encounterId: string, combatantId: string | null) {
  const { record, key } = useEncounterInputs(encounterId);
  return useQuery({
    queryKey: ["reachable", ...key, combatantId],
    queryFn: () => {
      if (!record || !combatantId) throw new Error("no combatant");
      const party = partyOf(record.encounter, useDocuments.getState().characters);
      return engine().reachable(record.encounter, party, combatantId, record.content);
    },
    enabled: record !== undefined && combatantId !== null,
  });
}

/** What a move to a square would do (`previewMove`): path, cost, zones, Opportunity Attacks. */
export function useMovePreview(
  encounterId: string,
  combatantId: string | null,
  to: { x: number; y: number } | null,
) {
  const { record, key } = useEncounterInputs(encounterId);
  return useQuery({
    queryKey: ["move", ...key, combatantId, to],
    queryFn: () => {
      if (!record || !combatantId || !to) throw new Error("no move");
      const party = partyOf(record.encounter, useDocuments.getState().characters);
      return engine().previewMove(record.encounter, party, { id: combatantId, to }, record.content);
    },
    enabled: record !== undefined && combatantId !== null && to !== null,
    placeholderData: keepPreviousData,
  });
}

/** Feet between two squares by the grid rule (`gridDistance`), for the measure tool. */
export function useDistance(
  from: { x: number; y: number } | null,
  to: { x: number; y: number } | null,
) {
  return useQuery({
    queryKey: ["distance", from, to],
    queryFn: () =>
      engine().distance(from as { x: number; y: number }, to as { x: number; y: number }),
    enabled: from !== null && to !== null,
  });
}

/** Ability modifiers for a stat block's scores. */
export function useModifiers(scores: Readonly<Record<string, number>> | null) {
  return useQuery({
    queryKey: ["modifiers", scores],
    queryFn: () => engine().modifiers(scores as Readonly<Record<string, number>>),
    enabled: scores !== null,
  });
}

/** The loaded content packs' manifests, in load order. */
export function usePacks() {
  const content = useContentKey();
  return useQuery({ queryKey: ["packs", content], queryFn: () => engine().packs() });
}

/** Imported packs (kenli F-008): their exact refs, by key, for Settings. */
export function useInstalledPacks() {
  return useQuery({
    queryKey: ["installed-packs", useDocuments((s) => Object.keys(s.revs).length)],
    queryFn: async () =>
      (await (await db()).getAll("packs")).map((p) => ({
        key: p.key,
        ref: p.ref,
        installed_at: p.installed_at,
        bundled: p.origin.kind === "bundled",
      })),
  });
}
