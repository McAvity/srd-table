/**
 * The engine's words in the app's language, rendered here in the worker (`renderMessage` is
 * engine code). Every engine string the app shows comes with its message: `notes` with
 * `messages`, `reasons` with `reason_messages`, `unavailable` with `unavailable_message`, an option reason's `text` with its `message`, an
 * issue's `message` with its `detail`… `localize` walks a facade result and replaces each such
 * text with its rendering in the current language. Documents (`build`, `state`, `encounter`,
 * `states`) are never touched: they're stored exactly as the engine returns them.
 */

import { type Message, renderMessage } from "srd-rules-engine";
import { ENGINE_LANGUAGES, type EngineLanguage } from "@/i18n/engine";

/** The language pack for a locale; `null` for English (the engine's own text). */
export function engineLanguage(locale: string): EngineLanguage | null {
  return ENGINE_LANGUAGES[locale] ?? null;
}

/** Message field → the text field it renders (on the same object). */
const PAIRS: readonly (readonly [string, string])[] = [
  ["messages", "notes"],
  ["reason_messages", "reasons"],
  ["unavailable_message", "unavailable"],
  ["reason_message", "reason"],
  ["label_message", "label"],
  ["note_message", "note"],
  ["cost_message", "cost"],
  ["question_message", "question"],
  // An issue (`message` + `detail`); a decision (`question` + `message`).
  ["detail", "message"],
  ["message", "question"],
  // An option's reason (`OptionReason`: `text` + `message`).
  ["message", "text"],
];

/** Fields holding documents: never rewritten. */
const DOCUMENTS = new Set(["build", "state", "states", "encounter"]);

function isMessage(v: unknown): v is Message {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Message).code === "string" &&
    typeof (v as Message).text === "string" &&
    typeof (v as Message).params === "object"
  );
}

export function renderAll(messages: readonly Message[], language: EngineLanguage | null): string[] {
  return messages.map((m) => (language ? render(m, language) : m.text));
}

function render(message: Message, language: EngineLanguage): string {
  return renderMessage(message, language.messages, { locale: language.locale });
}

/** `value` with every engine text in `language` (a copy; `value` itself is left alone). */
export function localize<T>(value: T, language: EngineLanguage | null): T {
  if (!language) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v !== "object" || v === null || isMessage(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = DOCUMENTS.has(k) ? x : walk(x);
    for (const [from, to] of PAIRS) {
      const m = out[from];
      const text = out[to];
      if (isMessage(m) && typeof text === "string") out[to] = render(m, language);
      else if (
        Array.isArray(m) &&
        Array.isArray(text) &&
        m.length === text.length &&
        m.every(isMessage)
      )
        out[to] = m.map((x) => render(x, language));
    }
    return out;
  };
  return walk(value) as T;
}
