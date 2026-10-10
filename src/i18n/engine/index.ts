/**
 * The engine's words in other languages: one `EngineLanguage` per locale, rendered in the engine
 * worker (`src/engine/messages.ts`). English needs none: the engine's own text is English.
 *
 * Adding a language: a file like `it.ts` with every message code (`MessageCode`: a missing one
 * fails the typecheck: list joiners, step titles, alignments and stat labels are codes too),
 * registered in `ENGINE_LANGUAGES` with its locale (plurals follow `Intl.PluralRules`); plus the
 * app's own words (`src/i18n/<locale>.ts`) and an entry in `LOCALES` (`src/i18n/index.ts`).
 */

import type { MessageCode } from "srd-rules-engine";
import { ENGINE_IT } from "./it";

export interface EngineLanguage {
  /** The locale the engine picks plural forms by (`Intl.PluralRules`). */
  readonly locale: string;
  /** A template for every message code, in the engine's syntax. */
  readonly messages: Readonly<Record<MessageCode, string>>;
}

export const ENGINE_LANGUAGES: Readonly<Record<string, EngineLanguage>> = {
  it: { locale: "it", messages: ENGINE_IT },
};
