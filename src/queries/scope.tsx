/**
 * The content catalog lookups below a screen use (kenli F-008, contract §9.5): a character's own
 * packs on its sheet and builder, the encounter's world on the table, and a combatant's own when a
 * panel shows one combatant. `undefined` content is the campaign's packs (Settings), which is
 * also what's used outside any scope (Compendium, Settings).
 */

import { createContext, type ReactNode, useContext } from "react";
import type { ContentContext } from "@/lib/canonical";
import { useDocuments } from "@/store/documents";

const Scope = createContext<{ readonly content: ContentContext | undefined }>({
  content: undefined,
});

export function ContentScope({
  content,
  children,
}: {
  content: ContentContext | undefined;
  children: ReactNode;
}) {
  return <Scope.Provider value={{ content }}>{children}</Scope.Provider>;
}

/** A character's own content (its sheet, its builder, its combatant). */
export function CharacterScope({ id, children }: { id: string; children: ReactNode }) {
  const content = useDocuments((s) => s.characters[id]?.content);
  return <ContentScope content={content}>{children}</ContentScope>;
}

/** One combatant: a character's own content, else (a monster) the encounter's world in scope. */
export function CombatantScope({
  character,
  children,
}: {
  character: string | null | undefined;
  children: ReactNode;
}) {
  const world = useScopeContent();
  const own = useDocuments((s) => (character ? s.characters[character] : undefined));
  if (!character) return <ContentScope content={world}>{children}</ContentScope>;
  return <ContentScope content={own?.content}>{children}</ContentScope>;
}

/** The content in scope (`undefined`: the campaign's packs). */
export function useScopeContent(): ContentContext | undefined {
  return useContext(Scope).content;
}
