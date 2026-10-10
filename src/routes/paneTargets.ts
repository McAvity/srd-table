/**
 * What the top bar's Table and Characters open, and what `/` opens. A player: the most recent
 * table their character is in, and their own sheet. The GM (or a player with neither): the table
 * and the character last opened. `null`: the list (nothing to open, or it was deleted).
 */

import { type DocumentsState, useDocuments } from "@/store/documents";
import { type LastOpened, type Role, useUi } from "@/store/ui";

type Docs = Pick<DocumentsState, "encounters" | "characters">;

export function tableTarget(docs: Docs, role: Role, last: LastOpened["encounter"]): string | null {
  if (role.kind === "player" && role.character) {
    const mine = Object.values(docs.encounters)
      .filter((e) => e.encounter.combatants.some((c) => c.character === role.character))
      .sort((a, b) => b.updated - a.updated);
    if (last && mine.some((e) => e.id === last)) return last;
    if (mine[0]) return mine[0].id;
  }
  return last && docs.encounters[last] ? last : null;
}

export function characterTarget(
  docs: Docs,
  role: Role,
  last: LastOpened["character"],
): string | null {
  if (role.kind === "player" && role.character && docs.characters[role.character])
    return role.character;
  return last && docs.characters[last] ? last : null;
}

export function useTableTarget(): string | null {
  const role = useUi((s) => s.role);
  const last = useUi((s) => s.lastOpened.encounter);
  return useDocuments((s) => tableTarget(s, role, last));
}

export function useCharacterTarget(): string | null {
  const role = useUi((s) => s.role);
  const last = useUi((s) => s.lastOpened.character);
  return useDocuments((s) => characterTarget(s, role, last));
}

/** Where `/` goes: the table, else the character, else the characters list. */
export function homeTarget():
  | { to: "/encounters/$id"; params: { id: string } }
  | { to: "/characters/$id/sheet"; params: { id: string }; search: Record<string, never> }
  | { to: "/characters" } {
  const docs = useDocuments.getState();
  const { role, lastOpened } = useUi.getState();
  const table = tableTarget(docs, role, lastOpened.encounter);
  if (table) return { to: "/encounters/$id", params: { id: table } };
  const character = characterTarget(docs, role, lastOpened.character);
  if (character) return { to: "/characters/$id/sheet", params: { id: character }, search: {} };
  return { to: "/characters" };
}
