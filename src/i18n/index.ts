/**
 * The app's own words, kept apart from components so another language is one more file
 * (`it.ts` satisfying `Messages`, registered in `catalogs` and `LOCALES`). Engine strings (reasons, notes, labels, SRD text) are shown as
 * the engine gives them: translating those is an engine gap (docs/ENGINE-GAPS.md).
 *
 * `t("nav.characters")`; placeholders are `{name}`; plurals are keys ending in `.one` / `.other`
 * read with `tn("characters.count", n)`.
 */

import { en } from "./en";
import { it } from "./it";

export type Messages = { readonly [K in keyof typeof en]: string };
export type MessageKey = keyof typeof en;
type PluralBase<K> = K extends `${infer B}.other` ? B : never;
export type PluralKey = PluralBase<MessageKey>;
export type Params = Readonly<Record<string, string | number>>;

const catalogs: Readonly<Record<string, Messages>> = { en, it };

/** The languages the app speaks, each named in its own language. */
export const LOCALES: readonly { readonly id: string; readonly name: string }[] = [
  { id: "en", name: "English" },
  { id: "it", name: "Italiano" },
];
let locale = "en";
let messages: Messages = en;

export function setLocale(next: string): void {
  const found = catalogs[next];
  if (!found) return;
  locale = next;
  messages = found;
}

export function t(key: MessageKey, params?: Params): string {
  return format(messages[key] ?? en[key], params);
}

export function tn(key: PluralKey, count: number, params?: Params): string {
  const rule = new Intl.PluralRules(locale).select(count);
  const variant = `${key}.${rule}` as MessageKey;
  const text = messages[variant] ?? messages[`${key}.other` as MessageKey];
  return format(text, { count: formatNumber(count), ...params });
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(locale).format(n);
}

/** `+3`, `−1`, `+0`: how modifiers are written. */
export function signed(n: number): string {
  return n < 0 ? `−${formatNumber(-n)}` : `+${formatNumber(n)}`;
}

/** `Sword, Shield and Bow` in the current language. */
export function formatList(
  items: readonly string[],
  type: "conjunction" | "disjunction" = "conjunction",
): string {
  return new Intl.ListFormat(locale, { type }).format(items);
}

function format(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}
