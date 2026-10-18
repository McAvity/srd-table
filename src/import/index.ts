/**
 * The importer (kenli F-008): one path for a URL and for files. `previewImport` fetches and
 * resolves the whole graph and validates it (nothing written); `commitPlan` writes it after the
 * user's decisions. See `docs/ARCHITECTURE.md` ("Import by URL").
 */

import { engine } from "@/engine/client";
import { type ContentContext, contentSha, type PackRef } from "@/lib/canonical";
import { db } from "@/persistence/db";
import { installationId } from "@/persistence/sync";
import { useDocuments } from "@/store/documents";
import { useSettings } from "@/store/settings";
import { characterContent } from "./export";
import type { Limits } from "./fetch";
import { type Plan, type Problem, planRaw, planTransfer, type Records } from "./plan";
import { type Graph, resolveGraph, type Source } from "./resolve";
import { ImportError } from "./transfer";

export { commitPlan } from "./commit";
export type {
  CharacterChoice,
  Decisions,
  EncounterChoice,
  Plan,
  PlanCharacter,
  Problem,
} from "./plan";
export type { Source } from "./resolve";

export interface PreviewOptions {
  readonly signal: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly limits?: Partial<Limits>;
  /** Raw files: the content they'd play with (`null`: not chosen yet). */
  readonly rawContent?: "campaign" | ContentContext | null;
}

export type Preview =
  | { readonly ok: true; readonly plan: Plan; readonly graph: Graph }
  | { readonly ok: false; readonly problem: Problem };

const records = (): Records => {
  const s = useDocuments.getState();
  return { characters: s.characters, encounters: s.encounters };
};

/** Packs installed here and served with the app (their exact refs). */
export async function availablePacks(): Promise<{ installed: PackRef[]; served: PackRef[] }> {
  const database = await db();
  const installed = (await database.getAll("packs")).map((p) => p.ref);
  const served: PackRef[] = [];
  for (const id of new Set(["srd-5.2.1", ...useSettings.getState().settings.packs])) {
    try {
      served.push(await engine().servedPack(id));
    } catch {
      // Not served (or the host is gone): only installed packs count then.
    }
  }
  return { installed, served };
}

export async function previewImport(source: Source, options: PreviewOptions): Promise<Preview> {
  try {
    const { installed, served } = await availablePacks();
    let installation: string | null = null;
    try {
      installation = installationId();
    } catch {
      installation = null;
    }
    const graph = await resolveGraph(source, {
      installed,
      served,
      installation,
      signal: options.signal,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
      localCharacter: async (recordId) => {
        const record = useDocuments.getState().characters[recordId];
        if (!record) return null;
        return {
          recordId,
          rev: record.rev ?? 0,
          sha256: await contentSha(await characterContent(record)),
        };
      },
    });
    const plan =
      graph.kind === "raw"
        ? await planRaw(graph, records(), options.rawContent ?? null)
        : await planTransfer(graph, records());
    return { ok: true, plan, graph };
  } catch (error) {
    if (error instanceof ImportError)
      return { ok: false, problem: { code: error.code, detail: error.detail } };
    if (options.signal.aborted) return { ok: false, problem: { code: "cancelled", detail: "" } };
    return {
      ok: false,
      problem: {
        code: "import_failed",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
