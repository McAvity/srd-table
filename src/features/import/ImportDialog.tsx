/**
 * Import by URL or from files (kenli F-008): one path for both. The whole graph is fetched and
 * checked first, then shown — every pack, character and encounter, what's already here, what
 * blocks — and nothing is written until Import is pressed with every decision made: a new copy
 * by default, a replacement only of a record picked by hand, a build without a play state only
 * as a new character after ticking its initialization (Q-01…Q-03). Nothing is matched by name.
 */

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, Reasons, Spinner } from "@/components/ui";
import { t } from "@/i18n";
import { en } from "@/i18n/en";
import {
  availablePacks,
  type CharacterChoice,
  commitPlan,
  type Decisions,
  type EncounterChoice,
  type Plan,
  type PlanCharacter,
  type Problem,
  previewImport,
  type Source,
} from "@/import";
import { blockers, contentLabel, defaultChoice, referencedBy } from "@/import/plan";
import type { ContentContext, PackRef } from "@/lib/canonical";
import { changedFields, downloadJson } from "@/lib/files";
import { fileSlug } from "@/lib/format";
import { admission } from "@/offline/admission";
import { useDocuments } from "@/store/documents";
import { useUi } from "@/store/ui";

/** A problem in the app's words (its code translated), then the technical detail. */
export function problemText(p: Problem): string {
  const code = p.code.startsWith("envelope_") ? "envelope" : p.code;
  const key = `import.problem.${code}` as keyof typeof en;
  const text = key in en ? t(key) : t("import.problem.other", { code: p.code });
  return p.detail ? `${text} (${p.detail})` : text;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 12) : "—");

export function ImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // kenli F-007 T05: an open import blocks an update until it closes (offline.md §7.3).
  useEffect(() => (open ? admission.hold("import_open") : undefined), [open]);
  const characters = useDocuments((s) => s.characters);
  const encounters = useDocuments((s) => s.encounters);
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"fetching" | "committing" | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [choices, setChoices] = useState<Record<string, CharacterChoice | undefined>>({});
  const [encounterChoice, setEncounterChoice] = useState<EncounterChoice>({ kind: "new" });
  const [rawContent, setRawContent] = useState<"campaign" | ContentContext | null>(null);
  const [contexts, setContexts] = useState<{ label: string; content: ContentContext }[]>([]);
  const [commitProblems, setCommitProblems] = useState<Problem[]>([]);
  const abort = useRef<AbortController | null>(null);
  const files = useRef<HTMLInputElement>(null);
  const records = { characters, encounters };

  const decisions: Decisions = useMemo(() => {
    const chosen: Record<string, CharacterChoice> = {};
    for (const [k, v] of Object.entries(choices)) if (v) chosen[k] = v;
    return {
      characters: chosen,
      encounter: encounterChoice,
      ...(rawContent ? { rawContent } : {}),
    };
  }, [choices, encounterChoice, rawContent]);
  const blocked = plan ? blockers(plan, decisions, records) : [];

  function reset() {
    abort.current?.abort();
    setPlan(null);
    setSource(null);
    setProblem(null);
    setChoices({});
    setEncounterChoice({ kind: "new" });
    setRawContent(null);
    setCommitProblems([]);
    setBusy(null);
  }

  async function run(next: Source, content: "campaign" | ContentContext | null = rawContent) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy("fetching");
    setProblem(null);
    setCommitProblems([]);
    setSource(next);
    const result = await previewImport(next, { signal: controller.signal, rawContent: content });
    if (abort.current !== controller) return;
    setBusy(null);
    if (!result.ok) {
      setPlan(null);
      setProblem(result.problem);
      return;
    }
    setPlan(result.plan);
    if (result.plan.raw && contexts.length === 0) {
      // Raw files: the user picks their content; offered: the campaign's, or the SRD with one
      // installed pack (nothing is preselected).
      const { installed, served } = await availablePacks();
      const srd = served.find((p) => p.id === "srd-5.2.1");
      const options: { label: string; content: ContentContext }[] = [];
      if (srd) {
        options.push({
          label: contentLabel({ packs: [srd], sources: null }) ?? "",
          content: { packs: [srd], sources: null },
        });
        for (const p of installed as PackRef[])
          options.push({
            label: contentLabel({ packs: [srd, p], sources: null }) ?? "",
            content: { packs: [srd, p], sources: null },
          });
      }
      setContexts(options);
    }
  }

  async function onFiles(list: FileList | null) {
    if (!list?.length) return;
    const read = await Promise.all(
      Array.from(list).map(async (f) => ({
        name: f.name,
        bytes: new Uint8Array(await f.arrayBuffer()),
      })),
    );
    if (files.current) files.current.value = "";
    await run({ files: read });
  }

  async function onConfirm() {
    if (!plan) return;
    setBusy("committing");
    const result = await commitPlan(plan, decisions);
    setBusy(null);
    if (!result.ok) {
      setCommitProblems([...result.problems]);
      return;
    }
    useUi.getState().toast([
      t("import.done", {
        characters: result.characters.length,
        encounters: result.encounters.length,
        packs: result.packs,
      }),
    ]);
    onOpenChange(false);
    reset();
    const encounter = result.encounters[0];
    const character = result.characters[0];
    if (encounter) await navigate({ to: "/encounters/$id", params: { id: encounter } });
    else if (character)
      await navigate({ to: "/characters/$id/sheet", params: { id: character }, search: {} });
  }

  const setChoice = (key: string, choice: CharacterChoice | undefined) =>
    setChoices((c) => ({ ...c, [key]: choice }));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title={t("import.title")}
      description={t("import.hint")}
      wide
      footer={
        <>
          <Button onClick={() => (busy ? abort.current?.abort() : onOpenChange(false))}>
            {busy ? t("import.cancelFetch") : t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            icon="download"
            disabled={!plan || blocked.length > 0 || busy !== null}
            onClick={() => void onConfirm()}
          >
            {t("import.confirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) void run({ url: url.trim() });
          }}
        >
          <label className="flex min-w-60 flex-1 flex-col gap-1">
            <span className="font-semibold">{t("import.url")}</span>
            <input
              className="field"
              type="url"
              inputMode="url"
              placeholder="https://…/dnd/library/d/character/….json"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <Button type="submit" disabled={!url.trim() || busy !== null}>
            {t("import.fetch")}
          </Button>
          <Button icon="upload" onClick={() => files.current?.click()} disabled={busy !== null}>
            {t("import.files")}
          </Button>
          <input
            ref={files}
            type="file"
            accept="application/json,.json"
            multiple
            hidden
            aria-label={t("import.files")}
            onChange={(e) => void onFiles(e.target.files)}
          />
        </form>
        {busy === "fetching" && <Spinner label={t("import.fetching")} />}
        {busy === "committing" && <Spinner label={t("import.committing")} />}
        {problem && <Reasons reasons={[problemText(problem)]} />}
        {plan && (
          <PlanView
            plan={plan}
            records={records}
            choices={choices}
            setChoice={setChoice}
            encounterChoice={encounterChoice}
            setEncounterChoice={setEncounterChoice}
            rawContent={rawContent}
            contexts={contexts}
            setRawContent={(c) => {
              setRawContent(c);
              if (source) void run(source, c);
            }}
          />
        )}
        {plan && blocked.length > 0 && (
          <div>
            <p className="font-semibold">{t("import.blocked")}</p>
            <Reasons reasons={[...new Set(blocked.map(problemText))]} />
          </div>
        )}
        {commitProblems.length > 0 && <Reasons reasons={commitProblems.map(problemText)} />}
      </div>
    </Dialog>
  );
}

function PlanView({
  plan,
  records,
  choices,
  setChoice,
  encounterChoice,
  setEncounterChoice,
  rawContent,
  contexts,
  setRawContent,
}: {
  plan: Plan;
  records: Parameters<typeof blockers>[2];
  choices: Record<string, CharacterChoice | undefined>;
  setChoice: (key: string, choice: CharacterChoice | undefined) => void;
  encounterChoice: EncounterChoice;
  setEncounterChoice: (c: EncounterChoice) => void;
  rawContent: "campaign" | ContentContext | null;
  contexts: { label: string; content: ContentContext }[];
  setRawContent: (c: "campaign" | ContentContext | null) => void;
}) {
  const allCharacters = Object.values(records.characters);
  const allEncounters = Object.values(records.encounters);
  return (
    <div className="space-y-3" data-testid="import-plan">
      {plan.raw && (
        <label className="flex flex-col gap-1">
          <span className="font-semibold">{t("import.rawContent")}</span>
          <select
            className="field"
            aria-label={t("import.rawContent")}
            value={
              rawContent === null
                ? ""
                : rawContent === "campaign"
                  ? "campaign"
                  : String(contexts.findIndex((c) => c.content === rawContent))
            }
            onChange={(e) => {
              const v = e.target.value;
              setRawContent(
                v === ""
                  ? null
                  : v === "campaign"
                    ? "campaign"
                    : (contexts[Number(v)]?.content ?? null),
              );
            }}
          >
            <option value="">{t("import.choose")}</option>
            <option value="campaign">{t("import.contentCampaign")}</option>
            {contexts.map((c, i) => (
              <option key={c.label} value={String(i)}>
                {c.label}
              </option>
            ))}
          </select>
          <span className="text-[13px] text-ink-muted">{t("import.rawHint")}</span>
        </label>
      )}
      {(plan.packs.length > 0 || plan.present.length > 0) && (
        <section>
          <h3 className="font-semibold">{t("import.packs")}</h3>
          <ul className="text-sm">
            {plan.packs.map((p) => (
              <li key={p.key}>
                {t("import.packInstall", {
                  id: p.ref.id,
                  version: p.ref.version ?? "—",
                  sha: short(p.ref.sha256),
                })}
              </li>
            ))}
            {plan.present.map((p) => (
              <li key={p.ref.sha256} className="text-ink-muted">
                {t("import.packPresent", {
                  id: p.ref.id,
                  version: p.ref.version ?? "—",
                  sha: short(p.ref.sha256),
                })}
              </li>
            ))}
          </ul>
        </section>
      )}
      {plan.characters.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-semibold">{t("import.characters")}</h3>
          {plan.characters.map((c) => (
            <CharacterRow
              key={c.key}
              c={c}
              choice={choices[c.key]}
              setChoice={(x) => setChoice(c.key, x)}
              all={allCharacters}
              records={records}
            />
          ))}
        </section>
      )}
      {plan.encounter && (
        <section className="space-y-1">
          <h3 className="font-semibold">{t("import.encounter")}</h3>
          <p className="text-sm">
            {plan.encounter.title} ·{" "}
            {t("import.content", {
              content: contentLabel(plan.encounter.world) ?? t("import.contentCampaign"),
            })}
          </p>
          <p className="text-sm text-ink-muted">
            {t("import.party", { keys: plan.encounter.partyKeys.join(", ") || "—" })}
          </p>
          {plan.raw &&
            plan.encounter.partyKeys.map((key) => {
              const choice = choices[`raw-key:${key}`];
              return (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <span>{t("import.mapKey", { key })}</span>
                  <select
                    className="field"
                    aria-label={t("import.mapKey", { key })}
                    value={choice?.kind === "use" ? choice.target : ""}
                    onChange={(e) =>
                      setChoice(
                        `raw-key:${key}`,
                        e.target.value ? { kind: "use", target: e.target.value } : undefined,
                      )
                    }
                  >
                    <option value="">{t("import.choose")}</option>
                    {allCharacters.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.build.name || r.id}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          <label className="flex items-center gap-2 text-sm">
            <span>{t("import.action")}</span>
            <select
              className="field"
              aria-label={t("import.encounterAction")}
              value={encounterChoice.kind === "new" ? "new" : encounterChoice.target}
              onChange={(e) =>
                setEncounterChoice(
                  e.target.value === "new"
                    ? { kind: "new" }
                    : { kind: "replace", target: e.target.value },
                )
              }
            >
              <option value="new">{t("import.choice.newEncounter")}</option>
              {allEncounters.map((e) => (
                <option key={e.id} value={e.id}>
                  {t("import.choice.replaceNamed", { name: e.name })}
                </option>
              ))}
            </select>
          </label>
          {encounterChoice.kind === "replace" && (
            <label className="flex items-center gap-2 text-sm text-orange">
              <input
                type="checkbox"
                checked={encounterChoice.confirmed === true}
                onChange={(e) =>
                  setEncounterChoice({ ...encounterChoice, confirmed: e.target.checked })
                }
              />
              <span>
                {t("import.replaceConfirm", {
                  name: records.encounters[encounterChoice.target]?.name ?? encounterChoice.target,
                })}
              </span>
            </label>
          )}
        </section>
      )}
    </div>
  );
}

function CharacterRow({
  c,
  choice,
  setChoice,
  all,
  records,
}: {
  c: PlanCharacter;
  choice: CharacterChoice | undefined;
  setChoice: (c: CharacterChoice | undefined) => void;
  all: readonly { id: string; build: { name: string }; rev?: number }[];
  records: Parameters<typeof blockers>[2];
}) {
  const effective = choice ?? defaultChoice(c) ?? undefined;
  const value =
    effective === undefined
      ? ""
      : effective.kind === "new" || effective.kind === "skip"
        ? effective.kind
        : `${effective.kind}:${effective.target}`;
  const target = effective && "target" in effective ? effective.target : null;
  const others = target && effective?.kind === "replace" ? referencedBy(target, records) : [];
  return (
    <div
      className="rounded-md border border-edge p-2 text-sm"
      data-testid={`import-character-${c.title}`}
    >
      <p className="font-semibold">
        {c.title}
        {c.partyKey ? ` · ${t("import.partyKey", { key: c.partyKey })}` : ""}
      </p>
      <p className="text-ink-muted">
        {c.sourceId ? `${c.sourceId} · ` : ""}
        {c.revision ? t("import.revision", { seq: c.revision.seq }) : t("import.revisionUnknown")} ·{" "}
        {t("import.content", { content: contentLabel(c.content) ?? t("import.contentCampaign") })} ·{" "}
        {t("import.stateOrigin", { origin: c.stateOrigin })}
      </p>
      {c.candidates.map((x) => (
        <p key={x.recordId} className="text-ink-muted">
          {t(`import.relation.${x.relation}`, { name: x.name })}
        </p>
      ))}
      {c.local && (
        <p className="text-ink-muted">
          {t(c.local.changed ? "import.localChanged" : "import.localSame", {
            name: records.characters[c.local.recordId]?.build.name || c.local.recordId,
          })}
        </p>
      )}
      <label className="mt-1 flex flex-wrap items-center gap-2">
        <span>{t("import.action")}</span>
        <select
          className="field"
          aria-label={t("import.characterAction", { name: c.title })}
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") setChoice(undefined);
            else if (v === "new") setChoice({ kind: "new", initialize: false });
            else if (v === "skip") setChoice({ kind: "skip" });
            else {
              const [kind, id] = v.split(":") as ["replace" | "use", string];
              setChoice({ kind, target: id });
            }
          }}
        >
          {!effective && <option value="">{t("import.choose")}</option>}
          {!c.local?.changed && <option value="new">{t("import.choice.new")}</option>}
          {!c.partyKey && c.candidates.some((x) => x.relation === "unchanged") && (
            <option value="skip">{t("import.choice.skip")}</option>
          )}
          {c.local && (
            <option value={`use:${c.local.recordId}`}>
              {t(c.local.changed ? "import.choice.useCurrent" : "import.choice.useLocal")}
            </option>
          )}
          {c.partyKey &&
            !c.local &&
            all.map((r) => (
              <option key={`use:${r.id}`} value={`use:${r.id}`}>
                {t("import.choice.useNamed", { name: r.build.name || r.id })}
              </option>
            ))}
          {!c.buildOnly &&
            !c.local &&
            all.map((r) => (
              <option key={`replace:${r.id}`} value={`replace:${r.id}`}>
                {t("import.choice.replaceNamed", { name: r.build.name || r.id })}
              </option>
            ))}
        </select>
      </label>
      {c.buildOnly && effective?.kind === "new" && (
        <label className="mt-1 flex items-center gap-2">
          <input
            type="checkbox"
            checked={effective.initialize === true}
            onChange={(e) => setChoice({ kind: "new", initialize: e.target.checked })}
          />
          <span>{t("import.initialize")}</span>
        </label>
      )}
      {effective?.kind === "replace" && target && records.characters[target] && (
        <ReplaceDiff
          c={c}
          current={records.characters[target]}
          others={others}
          confirmed={effective.confirmed === true}
          confirm={(confirmed) => setChoice({ kind: "replace", target, confirmed })}
        />
      )}
      <Reasons reasons={c.problems.map(problemText)} className="mt-1" />
    </div>
  );
}

/** Before a replacement: what changes, field by field, and the current record to keep a copy. */
function ReplaceDiff({
  c,
  current,
  others,
  confirmed,
  confirm,
}: {
  c: PlanCharacter;
  current: NonNullable<Parameters<typeof blockers>[2]["characters"][string]>;
  others: readonly string[];
  confirmed: boolean;
  confirm: (confirmed: boolean) => void;
}) {
  const build = c.build ? changedFields(current.build, c.build).map((f) => `build.${f}`) : [];
  const state = c.state ? changedFields(current.state, c.state).map((f) => `state.${f}`) : [];
  const content =
    contentLabel(current.content ?? null) !== contentLabel(c.content) ? ["content"] : [];
  const fields = [...build, ...state, ...content];
  return (
    <div className="mt-1 space-y-1 text-orange">
      <p>
        {t("import.replaceWarning")}
        {others.length ? ` ${t("import.replaceUsedBy", { names: others.join(", ") })}` : ""}
      </p>
      <p data-testid="import-diff">{t("import.diff", { fields: fields.join(", ") || "—" })}</p>
      <Button
        size="sm"
        icon="download"
        onClick={() => {
          const slug = fileSlug(current.build.name, current.id);
          downloadJson(`${slug}.json`, current.build);
          downloadJson(`${slug}.state.json`, current.state);
        }}
      >
        {t("import.downloadCurrent")}
      </Button>
      <label className="flex items-center gap-2 text-ink">
        <input type="checkbox" checked={confirmed} onChange={(e) => confirm(e.target.checked)} />
        <span>{t("import.replaceConfirm", { name: current.build.name || current.id })}</span>
      </label>
    </div>
  );
}
