/**
 * kenli F-007 T04: the prepared campaign context (contract offline.md §5.3). A record without its
 * own `content` plays on the campaign's packs (Settings); "Prepare offline" stores the exact refs
 * those packs had (read whole, hashed, kept in `packs`) under `offline.campaign-context.v1`, with a
 * fingerprint of the settings. While the fingerprint matches the current settings, every reader
 * of the campaign catalog — play, the Compendium, F-008 exports, the local copy — uses exactly
 * those refs from local storage, never the host and never another version; records keep their own
 * (absent) pins. Other settings make it unused (not "the latest installed"); the same settings
 * again make it used again.
 */

import { engine } from "@/engine/client";
import { type ContentContext, contentSha, type PackRef } from "@/lib/canonical";
import type { db } from "@/persistence/db";

export const CAMPAIGN_CONTEXT_KEY = "offline.campaign-context.v1";
export const CAMPAIGN_CONTEXT_SCHEMA = "srd-table.campaign-context/1";

export interface CampaignSettingsRef {
  readonly packs: readonly string[];
  readonly sources: readonly string[] | null;
}

export interface PreparedCampaign {
  readonly schema: typeof CAMPAIGN_CONTEXT_SCHEMA;
  readonly settings_fingerprint: string;
  readonly packs: readonly string[];
  readonly sources: readonly string[] | null;
  readonly context: ContentContext;
  readonly prepared_at: number;
  readonly release_id: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const canonicalSources = (s: readonly string[] | null) =>
  s === null ? null : [...new Set(s)].sort();

/** Fingerprint of campaign settings: SHA-256 of JCS({packs in order, sources sorted unique|null}). */
export const settingsFingerprint = (packs: readonly string[], sources: readonly string[] | null) =>
  contentSha({ packs: [...packs], sources: canonicalSources(sources) });

const isRef = (v: unknown): v is PackRef => {
  const r = v as PackRef | null;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.id === "string" &&
    (r.version === null || typeof r.version === "string") &&
    typeof r.sha256 === "string" &&
    HEX64.test(r.sha256)
  );
};
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** A stored prepared context when its shape is right and consistent with itself, else `null`. */
export function parsePrepared(raw: unknown): PreparedCampaign | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.schema !== CAMPAIGN_CONTEXT_SCHEMA) return null;
  if (typeof o.settings_fingerprint !== "string" || !HEX64.test(o.settings_fingerprint))
    return null;
  if (!strings(o.packs) || o.packs.length === 0) return null;
  if (!(o.sources === null || strings(o.sources))) return null;
  const c = o.context as Record<string, unknown> | null;
  if (typeof c !== "object" || c === null || !Array.isArray(c.packs) || !c.packs.every(isRef))
    return null;
  if (!(c.sources === null || strings(c.sources))) return null;
  const refs = c.packs as PackRef[];
  const packs = o.packs as string[];
  if (refs.length !== packs.length || refs.some((r, i) => r.id !== packs[i])) return null;
  if (
    JSON.stringify(canonicalSources(c.sources as string[] | null)) !==
    JSON.stringify(canonicalSources(o.sources as string[] | null))
  )
    return null;
  if (!Number.isSafeInteger(o.prepared_at)) return null;
  if (!(o.release_id === null || typeof o.release_id === "string")) return null;
  return raw as PreparedCampaign;
}

let current: PreparedCampaign | null = null;

/** The prepared context this session read or wrote (whatever the settings now). */
export function preparedCampaign(): PreparedCampaign | null {
  return current;
}

/** After a preparation (or in tests): the prepared context of this session. */
export function setPreparedCampaign(prepared: PreparedCampaign | null): void {
  current = prepared;
}

/** Read the stored prepared context at start (an unreadable one counts as none). */
export async function loadPreparedCampaign(
  database: Awaited<ReturnType<typeof db>>,
): Promise<PreparedCampaign | null> {
  current = parsePrepared(await database.get("settings", CAMPAIGN_CONTEXT_KEY));
  return current;
}

/** The prepared exact context when it matches these settings, else `null`. */
export async function matchingContext(
  settings: CampaignSettingsRef,
): Promise<ContentContext | null> {
  const p = current;
  if (!p) return null;
  const fingerprint = await settingsFingerprint(settings.packs, settings.sources);
  return p.settings_fingerprint === fingerprint ? p.context : null;
}

/** Frozen T04 API: the prepared context, the current fingerprint and whether they match. */
export async function readCampaignContext(settings: CampaignSettingsRef): Promise<{
  readonly prepared: PreparedCampaign | null;
  readonly fingerprint: string;
  readonly matches: boolean;
  readonly context: ContentContext | null;
}> {
  const fingerprint = await settingsFingerprint(settings.packs, settings.sources);
  const matches = !!current && current.settings_fingerprint === fingerprint;
  return {
    prepared: current,
    fingerprint,
    matches,
    context: matches ? (current?.context ?? null) : null,
  };
}

/** Configure the campaign catalog: the prepared exact context when it matches, else the settings. */
export async function configureCampaign(settings: CampaignSettingsRef): Promise<boolean> {
  return engine().configureCampaign({
    settings: { packs: settings.packs, sources: settings.sources },
    prepared: await matchingContext(settings),
  });
}
