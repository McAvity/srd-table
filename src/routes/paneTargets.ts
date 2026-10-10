/**
 * What the top bar's Table and Characters open. A player: the most recent table their character
 * is in, and their own sheet. The GM (or a player with neither): the table and the character
 * last opened. `null`: the list (nothing to open, or it was deleted).
 */

import { useDocuments } from "@/store/documents";
import { useUi } from "@/store/ui";

export function useTableTarget(): string | null {
  const role = useUi((s) => s.role);
  const last = useUi((s) => s.lastOpened.encounter);
  return useDocuments((s) => {
    if (role.kind === "player" && role.character) {
      const mine = Object.values(s.encounters)
        .filter((e) => e.encounter.combatants.some((c) => c.character === role.character))
        .sort((a, b) => b.updated - a.updated);
      if (last && mine.some((e) => e.id === last)) return last;
      if (mine[0]) return mine[0].id;
    }
    return last && s.encounters[last] ? last : null;
  });
}

export function useCharacterTarget(): string | null {
  const role = useUi((s) => s.role);
  const last = useUi((s) => s.lastOpened.character);
  return useDocuments((s) => {
    if (role.kind === "player" && role.character && s.characters[role.character])
      return role.character;
    return last && s.characters[last] ? last : null;
  });
}
