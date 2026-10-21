/**
 * kenli F-006 T03: the History side panel. A toggle in the top bar opens it beside any screen (the
 * sheet, a table, a list): it stays open while playing (non-modal; Esc or the close button shuts it,
 * focus goes back to the toggle). It shows one character's journal — the screen's character, or the
 * one picked (a table offers its party) — newest first, a page at a time with "older" to go on (no
 * entry is ever cut): each roll with its changes (late Advantage, Heroic Inspiration, a Critical
 * Hit), each with its own cost and status, and the roll's current result put together from them; rests, play
 * actions, encounter actions and import boundaries. Above them: the character's days (by hand),
 * Long Rest counts, and whether this tab saved its journal. History stays on this device.
 *
 * kenli F-007 T03: a character made from a local copy reads its journal like any other. References
 * outside the copy (`ext:<installation>:<id>`: another character, an encounter, an earlier entry)
 * are named from the entries or the copy's own record of encounter names, marked "outside this
 * copy", and never matched with a record or encounter here; a decision the copy was waiting for is
 * shown as historical, never resumed. Engine messages are rendered as text in the app's language.
 * Stored request/result values are opaque (R04-02): read only through guards, an unreadable shape
 * gives a neutral line, and a group that still can't be drawn never takes the panel down.
 */

import { useRouterState } from "@tanstack/react-router";
import { Dialog as RDialog } from "radix-ui";
import { Component, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Button, cx, Empty } from "@/components/ui";
import { t } from "@/i18n";
import { inheritedEncounterNames, isExternal, localCopyOf } from "@/import/localCopy/format";
import { byOperations, entryCount, groupFrom, longRests, page } from "@/persistence/history";
import { flushNow, unsavedState } from "@/persistence/sync";
import { usePlayView, useRenderedMessages } from "@/queries";
import { characterKeysOf, useDocuments } from "@/store/documents";
import {
  type HistoryDay,
  type HistoryEntry,
  outcomeOf,
  projection,
  RESULT_KINDS,
  useHistory,
} from "@/store/history";
import { useUi } from "@/store/ui";
import {
  changeText,
  costText,
  dayName,
  field,
  label,
  messagesOf,
  outcomeText,
  plain,
  titleOf,
} from "./format";

const PAGE = 50;

/** The top bar's toggle and the panel it opens (one Radix dialog, so focus returns to the toggle). */
export function HistoryControl() {
  const open = useUi((s) => s.history.open);
  const setHistory = useUi((s) => s.setHistory);
  return (
    <RDialog.Root open={open} onOpenChange={(o) => setHistory({ open: o })} modal={false}>
      <RDialog.Trigger asChild>
        <button
          type="button"
          className="btn"
          data-on={open ? "true" : undefined}
          aria-label={t("history.toggle")}
          title={t("history.toggle")}
        >
          <Icon name="scroll" />
          <span className="hidden text-[15px] sm:inline">{t("history.title")}</span>
        </button>
      </RDialog.Trigger>
      <RDialog.Portal>
        <RDialog.Content
          // A side panel to play beside: clicks outside keep it open.
          onInteractOutside={(e) => e.preventDefault()}
          className="panel fixed top-0 right-0 z-40 flex h-full w-full max-w-[440px] flex-col border-l border-edge-strong shadow-panel"
          aria-describedby={undefined}
        >
          {open && <HistoryBody />}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/** The character the panel shows: the one picked, else the screen's, the player's, the last opened. */
function useSubject(): { id: string | null; party: string[] } {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const characters = useDocuments((s) => s.characters);
  const encounters = useDocuments((s) => s.encounters);
  const picked = useUi((s) => s.history.character);
  const role = useUi((s) => s.role);
  const lastOpened = useUi((s) => s.lastOpened.character);
  const onSheet = /^\/characters\/([^/]+)/.exec(path)?.[1];
  const onTable = /^\/encounters\/([^/]+)/.exec(path)?.[1];
  const table = onTable ? encounters[onTable] : undefined;
  const party = table ? characterKeysOf(table.encounter).filter((k) => characters[k]) : [];
  const candidates = [
    picked,
    onSheet,
    role.kind === "player" ? role.character : null,
    party[0],
    lastOpened,
    Object.keys(characters)[0],
  ];
  return { id: candidates.find((c): c is string => !!c && !!characters[c]) ?? null, party };
}

function HistoryBody() {
  const { id, party } = useSubject();
  const characters = useDocuments((s) => s.characters);
  const setHistory = useUi((s) => s.setHistory);
  const ordered = useMemo(
    () =>
      Object.values(characters).sort(
        (a, b) => (party.includes(b.id) ? 1 : 0) - (party.includes(a.id) ? 1 : 0),
      ),
    [characters, party],
  );
  return (
    <>
      <div className="flex items-center gap-2 border-b border-edge p-3">
        <RDialog.Title className="flex-1 font-display text-2xl text-ink">
          {t("history.title")}
        </RDialog.Title>
        <RDialog.Close asChild>
          <Button variant="ghost" icon="x" iconOnly label={t("history.close")} />
        </RDialog.Close>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {ordered.length === 0 ? (
          <Empty icon="sheet">{t("history.noCharacters")}</Empty>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink-muted">{t("history.character")}</span>
              <select
                className="min-h-11 rounded border border-edge bg-card px-2"
                value={id ?? ""}
                onChange={(e) => setHistory({ character: e.target.value || null })}
              >
                {ordered.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.build.name || t("common.unnamed")}
                    {party.includes(c.id) ? ` · ${t("history.inThisTable")}` : ""}
                  </option>
                ))}
              </select>
            </label>
            {party.length > 1 && (
              <fieldset className="flex flex-wrap gap-1.5">
                <legend className="sr-only">{t("history.party")}</legend>
                {party.map((k) => (
                  <Button
                    key={k}
                    size="sm"
                    on={k === id}
                    aria-pressed={k === id}
                    onClick={() => setHistory({ character: k })}
                  >
                    {characters[k]?.build.name || t("common.unnamed")}
                  </Button>
                ))}
              </fieldset>
            )}
            {id && <Journal key={id} id={id} />}
          </>
        )}
        <p className="text-[13px] text-ink-muted" data-testid="history-local">
          <Icon name="lock" size={14} className="mr-1 inline" />
          {t("history.local")}
        </p>
        <p className="text-[13px] text-ink-muted">{t("history.localCopyHint")}</p>
      </div>
    </>
  );
}

interface Loaded {
  readonly groups: readonly (readonly HistoryEntry[])[];
  readonly shown: number;
  /** The page size it was read with (a larger one is being read while they differ). */
  readonly limit: number;
  readonly total: number;
  readonly rests: { readonly total: number; readonly by_day: Record<string, number> };
  /**
   * The earlier entries a follow-up or an answer refers to (`links.follows/continues`), by operation,
   * also when off the page or the day shown; `null`: not in this character's history (R04-03).
   */
  readonly linked: Readonly<Record<string, HistoryEntry | null>>;
}

/** A page of a character's journal with every group it touches made whole (roots older than it). */
function useJournal(id: string, dayId: string | null, limit: number): Loaded | null {
  const session = useHistory((s) => s.entries);
  const head = useHistory((s) => s.meta[id]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the session and head are triggers to read again
  useEffect(() => {
    let live = true;
    void (async () => {
      const rows = await page(id, { limit, ...(dayId ? { dayId } : {}) });
      const roots = new Map<string, HistoryEntry>();
      for (const e of rows) if (e.operation_id === e.group_id) roots.set(e.group_id, e);
      const missing = [...new Set(rows.map((e) => e.group_id))].filter((g) => !roots.has(g));
      for (const r of await byOperations(id, missing))
        if (r.operation_id === r.group_id) roots.set(r.group_id, r);
      const groups: HistoryEntry[][] = [];
      const order = [...new Set(rows.map((e) => e.group_id))];
      for (const g of order) {
        const root = roots.get(g);
        groups.push(root ? await groupFrom(root) : rows.filter((e) => e.group_id === g));
      }
      const links = [
        ...new Set(
          groups
            .flat()
            .flatMap((e) => [e.links.follows, e.links.continues].filter((x): x is string => !!x)),
        ),
      ];
      const found = await byOperations(id, links);
      const linked: Record<string, HistoryEntry | null> = {};
      for (const op of links) linked[op] = found.find((e) => e.operation_id === op) ?? null;
      const [total, rests] = await Promise.all([entryCount(id), longRests(id)]);
      if (live) setLoaded({ groups, shown: rows.length, limit, total, rests, linked });
    })();
    return () => {
      live = false;
    };
  }, [id, dayId, limit, session, head]);
  return loaded;
}

function Journal({ id }: { id: string }) {
  const head = useHistory((s) => s.meta[id]);
  const [dayId, setDayId] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const loaded = useJournal(id, dayId, limit);
  const days = head?.days ?? [];
  const dayOf = (dayIdOf: string) => days.find((d) => d.id === dayIdOf);
  const encounters = useDocuments((s) => s.encounters);
  const origin = useDocuments((s) => s.characters[id]?.origin);
  // kenli F-007 T03: names of encounters outside this copy, as the copy recorded them.
  const external = useMemo(() => inheritedEncounterNames(origin), [origin]);
  const copied = localCopyOf(origin)?.entry_count ?? 0;
  const encounterName = (eid: string) =>
    isExternal(eid)
      ? (external.get(eid) ?? undefined)
      : Object.hasOwn(encounters, eid)
        ? encounters[eid]?.name
        : undefined;
  const { data } = usePlayView(id);
  const nameOfUse = (key: string) => data?.sheet.play.uses.find((u) => u.key === key)?.name;
  return (
    <div className="space-y-3">
      <SaveStatus id={id} />
      <Days id={id} rests={loaded?.rests ?? null} />
      <label className="flex items-center gap-2 text-sm">
        <span className="text-ink-muted">{t("history.show")}</span>
        <select
          className="min-h-11 flex-1 rounded border border-edge bg-card px-2"
          value={dayId ?? ""}
          onChange={(e) => {
            setDayId(e.target.value || null);
            setLimit(PAGE);
          }}
        >
          <option value="">{t("history.allDays")}</option>
          {[...days].reverse().map((d) => (
            <option key={d.id} value={d.id}>
              {dayName(d)}
            </option>
          ))}
        </select>
      </label>
      {!loaded ? (
        <p className="text-sm text-ink-muted">{t("history.loading")}</p>
      ) : loaded.groups.length === 0 ? (
        <Empty icon="scroll">{t("history.empty")}</Empty>
      ) : (
        <ol className="space-y-2" aria-label={t("history.entries")}>
          {loaded.groups.map((g, i) => {
            const first = g[0] as HistoryEntry;
            const prev = loaded.groups[i - 1]?.[0];
            return (
              <li key={first.group_id}>
                {(!prev || prev.day_id !== first.day_id) && (
                  <h3 className="mt-1 mb-1 text-sm font-bold text-ink-muted">
                    {dayName(dayOf(first.day_id))}
                  </h3>
                )}
                <GroupBoundary>
                  <Group
                    entries={g}
                    nameOfUse={nameOfUse}
                    encounterName={encounterName}
                    copied={copied}
                    linkOf={(op) =>
                      Object.hasOwn(loaded.linked, op) ? (loaded.linked[op] ?? null) : null
                    }
                  />
                </GroupBoundary>
              </li>
            );
          })}
        </ol>
      )}
      {loaded && loaded.shown >= loaded.limit && (
        <Button
          className="w-full"
          disabled={loaded.limit !== limit}
          onClick={() => setLimit((n) => n + PAGE)}
        >
          {loaded.limit !== limit ? t("history.loading") : t("history.older")}
        </Button>
      )}
      {loaded && (
        <p className="text-[13px] text-ink-faint" data-testid="history-count">
          {t("history.count", { shown: loaded.shown, total: loaded.total })}
        </p>
      )}
    </div>
  );
}

/**
 * A roll group's current result as text (`null`: its root was undone). Its stored results are
 * opaque historical JSON (R04-02): a shape the projection can't read gives a neutral line.
 */
function currentText(entries: readonly HistoryEntry[], root: HistoryEntry): string | null {
  try {
    const current = projection(entries, root.group_id);
    if (!current) return null;
    const values = outcomeOf(root.kind, current, { label: label(field(root.request, "label")) });
    return `${t("history.current")}: ${values.map(outcomeText).join(" | ")}`;
  } catch {
    return t("history.currentAsRecorded");
  }
}

/**
 * A group that can't be drawn (a stored shape no reader expects) shows a neutral line instead of
 * taking the whole panel down; its data stays as it was recorded.
 */
class GroupBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <p
        className="rounded border border-edge bg-card p-2 text-sm"
        data-testid="history-unreadable"
      >
        {t("history.entryAsRecorded")}
      </p>
    ) : (
      this.props.children
    );
  }
}

/** One roll with its changes (or one action): its current result and each entry's own line. */
function Group({
  entries,
  nameOfUse,
  encounterName,
  copied,
  linkOf,
}: {
  entries: readonly HistoryEntry[];
  nameOfUse: (key: string) => string | undefined;
  encounterName: (id: string) => string | undefined;
  /** How many of the first entries came with a local copy (their pending decisions are history). */
  copied: number;
  linkOf: (op: string) => HistoryEntry | null;
}) {
  const root = entries[0] as HistoryEntry;
  const isRoll = RESULT_KINDS.has(root.kind) && entries.length > 1;
  const current = isRoll ? currentText(entries, root) : null;
  return (
    <article
      className={cx(
        "rounded border border-edge bg-card p-2",
        root.status === "undone" && "opacity-80",
      )}
      data-testid="history-group"
    >
      {isRoll && (
        <p className="mb-1 text-sm font-semibold" data-testid="history-current">
          {current ?? t("history.currentNone")}
        </p>
      )}
      <ul className="space-y-1.5">
        {entries.map((e) => (
          <EntryLine
            key={e.id}
            e={e}
            child={e !== root}
            nameOfUse={nameOfUse}
            encounterName={encounterName}
            copied={copied}
            linkOf={linkOf}
          />
        ))}
      </ul>
    </article>
  );
}

function EntryLine({
  e,
  child,
  nameOfUse,
  encounterName,
  copied,
  linkOf,
}: {
  e: HistoryEntry;
  child: boolean;
  nameOfUse: (key: string) => string | undefined;
  encounterName: (id: string) => string | undefined;
  copied: number;
  linkOf: (op: string) => HistoryEntry | null;
}) {
  const { data: rendered } = useRenderedMessages(`history:${e.id}`, [e.messages]);
  /** The earlier action this one follows or answers: named, with its own result and status. */
  const context = (op: string, kind: "follows" | "answers") => {
    if (isExternal(op)) return t("history.context.external");
    const to = linkOf(op);
    if (!to)
      return kind === "follows"
        ? t("history.context.followsMissing")
        : t("history.context.answersMissing");
    const text = t(kind === "follows" ? "history.context.follows" : "history.context.answers", {
      seq: to.seq,
      title: titleOf(to, encounterName),
    });
    const result = to.outcome.map(outcomeText).join(" | ");
    const status = to.status === "undone" ? ` (${t("history.status.undone")})` : "";
    return `${text}${result ? ` — ${result}` : ""}${status}`;
  };
  const badges: string[] = [];
  if (e.status === "undone") badges.push(t("history.status.undone"));
  if (!e.commit && e.kind !== "import_boundary") badges.push(t("history.status.noChange"));
  const outside =
    isExternal(e.context.encounter_id) ||
    e.participants.some((p) => isExternal(p.record_id)) ||
    isExternal(e.links.follows) ||
    isExternal(e.links.continues);
  if (e.pending_decision)
    badges.push(
      e.seq <= copied || isExternal(e.context.encounter_id)
        ? t("history.status.pendingHistorical")
        : t("history.status.pending"),
    );
  if (outside) badges.push(t("history.external"));
  if (e.links.continues) badges.push(t("history.status.continues"));
  if (e.links.follows) badges.push(t("history.status.follows"));
  if (e.forced) badges.push(t("history.status.forced"));
  if (e.rest?.override) badges.push(t("history.status.dmException"));
  if (e.effect.mode === "replace") badges.push(t("history.status.replaces"));
  if (e.role === "affected") badges.push(t("history.status.affected"));
  const others = e.participants.filter((p) => p.record_id !== e.record_id);
  return (
    <li
      className={cx("text-sm", child && "border-l-2 border-edge pl-2")}
      data-testid="history-entry"
      data-status={e.status}
      data-kind={e.kind}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={cx("font-semibold", e.status === "undone" && "line-through")}>
          {titleOf(e, encounterName)}
        </span>
        <span className="text-[13px] text-ink-faint">
          #{e.seq} · {new Date(e.at).toLocaleTimeString()}
          {e.context.round !== null && e.context.round > 0
            ? ` · ${t("history.round", { round: e.context.round })}`
            : ""}
        </span>
      </div>
      {badges.length > 0 && (
        <p className="flex flex-wrap gap-1">
          {badges.map((b) => (
            <span
              key={b}
              className="rounded bg-card-3 px-1.5 text-[13px]"
              data-testid="history-badge"
            >
              {b}
            </span>
          ))}
        </p>
      )}
      {e.links.follows && (
        <p className="text-[13px] text-ink-muted" data-testid="history-context">
          {context(e.links.follows, "follows")}
        </p>
      )}
      {e.links.continues && (
        <p className="text-[13px] text-ink-muted" data-testid="history-context">
          {context(e.links.continues, "answers")}
        </p>
      )}
      {e.outcome.length > 0 && (
        <p data-testid="history-outcome">{e.outcome.map(outcomeText).join(" | ")}</p>
      )}
      {e.rest && e.rest.dice.length > 0 && (
        <p>
          {t("history.restDice", {
            dice: e.rest.dice
              .map((d) =>
                d.rerolled_from
                  ? `d${d.die}: ${plain(field(d.rerolled_from, "total"))} → ${plain(field(d.roll, "total"))}`
                  : `d${d.die}: ${plain(field(d.roll, "total"))}`,
              )
              .join(", "),
          })}
        </p>
      )}
      {e.rest?.override?.note && <p>{t("history.dmNote", { note: e.rest.override.note })}</p>}
      {e.import && (
        <p data-testid="history-import">
          {t("history.importBoundary", { before: e.import.gen_before, after: e.import.gen_after })}
        </p>
      )}
      <p data-testid="history-costs">
        {e.costs.length
          ? `${t("history.costs")}: ${e.costs.map((c) => costText(c, nameOfUse)).join(", ")}`
          : t("history.noCost")}
      </p>
      {others.length > 0 && (
        <p className="text-[13px] text-ink-muted">
          {t("history.with", {
            names: others
              .map(
                (p) =>
                  `${p.name || t("common.unnamed")}${isExternal(p.record_id) ? ` (${t("history.external")})` : ""}`,
              )
              .join(", "),
          })}
        </p>
      )}
      {(e.effect.state_delta.length > 0 || messagesOf(e).length > 0) && (
        <details className="text-[13px] text-ink-muted">
          <summary className="cursor-pointer">{t("history.details")}</summary>
          <ul>
            {/* Rendered as text only (never HTML): in the app's language, else as stored. */}
            {e.messages.map((m, i) =>
              m.text ? (
                <li key={`m-${i}`} data-testid="history-message">
                  {rendered?.[0]?.[i] || m.text}
                </li>
              ) : null,
            )}
            {e.effect.state_delta.map((c) => (
              <li key={`d-${c.path}`}>{changeText(c)}</li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/** Whether this tab saved the character's journal: pending, saved, a failure to retry, a conflict. */
function SaveStatus({ id }: { id: string }) {
  const save = useHistory((s) => s.saveState);
  const conflict = useHistory((s) => s.conflicts[id]);
  useHistory((s) => s.entries); // read again on every capture
  useHistory((s) => s.meta[id]); // and on every save (the head's rev)
  const { entries: unsaved, days } = unsavedState(id);
  const dirty = unsaved > 0 || days;
  const [retrying, setRetrying] = useState(false);
  if (conflict)
    return (
      <p
        role="alert"
        className="rounded border border-red p-2 text-sm text-red"
        data-testid="history-save"
      >
        {conflict === "history"
          ? t("history.save.conflictHistory", { count: unsaved })
          : t("history.save.conflictDocument", { count: unsaved })}
      </p>
    );
  if (save.status === "failed" && dirty)
    return (
      <div
        role="alert"
        className="rounded border border-red p-2 text-sm"
        data-testid="history-save"
      >
        <p className="text-red">
          {unsaved > 0
            ? t("history.save.failed", { count: unsaved })
            : t("history.save.failedDays")}
        </p>
        <p className="text-[13px] text-ink-muted">{save.reason}</p>
        <Button
          size="sm"
          className="mt-1"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            try {
              await flushNow();
            } catch {
              // still failing: the state says so
            } finally {
              setRetrying(false);
            }
          }}
        >
          {t("history.save.retry")}
        </Button>
      </div>
    );
  if (dirty)
    return (
      <p className="text-sm text-ink-muted" role="status" data-testid="history-save">
        {unsaved > 0
          ? t("history.save.pending", { count: unsaved })
          : t("history.save.pendingDays")}
      </p>
    );
  return (
    <p className="text-[13px] text-ink-faint" role="status" data-testid="history-save">
      {t("history.save.saved")}
    </p>
  );
}

/** The character's days: the current one, the next, a label, a correction; Long Rest counts. */
function Days({
  id,
  rests,
}: {
  id: string;
  rests: { readonly total: number; readonly by_day: Record<string, number> } | null;
}) {
  const head = useHistory((s) => s.meta[id]);
  const ensure = useHistory((s) => s.ensureMeta);
  const next = useHistory((s) => s.startNextDay);
  const rename = useHistory((s) => s.renameDay);
  const switchTo = useHistory((s) => s.setCurrentDay);
  const [label, setLabel] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // A character's first day starts when its history is first looked at (no past is made up).
  useEffect(() => {
    if (!useHistory.getState().meta[id]) ensure(id);
  }, [id, ensure]);
  if (!head) return null;
  const current: HistoryDay | undefined = head.days.find((d) => d.id === head.current_day_id);
  const today = rests?.by_day[head.current_day_id] ?? 0;
  const done = (r: { ok: true } | { ok: false; code: string }) => {
    if (r.ok) {
      setLabel("");
      setProblem(null);
    } else setProblem(t(r.code as "history.dayLabelInvalid"));
  };
  return (
    <section className="rounded border border-edge p-2" aria-label={t("history.days")}>
      <p className="font-semibold" data-testid="history-day">
        {t("history.today", { day: dayName(current) })}
      </p>
      <p className="text-sm" data-testid="history-rests">
        {t("history.restsCount", { today, total: rests?.total ?? 0 })}
      </p>
      {today > 1 && (
        <p className="text-sm text-orange">{t("history.restsMany", { count: today })}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <input
          ref={input}
          className="min-h-11 min-w-0 flex-1 rounded border border-edge bg-card px-2 text-sm"
          aria-label={t("history.dayLabel")}
          placeholder={t("history.dayLabel")}
          maxLength={60}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Button size="sm" onClick={() => done(rename(id, head.current_day_id, label))}>
          {t("history.renameDay")}
        </Button>
        <Button size="sm" variant="primary" onClick={() => done(next(id, label))}>
          {t("history.nextDay")}
        </Button>
      </div>
      {problem && (
        <p role="alert" className="mt-1 text-sm text-red">
          {problem}
        </p>
      )}
      {head.days.length > 1 && (
        <label className="mt-2 flex items-center gap-2 text-sm">
          <span className="text-ink-muted">{t("history.correctDay")}</span>
          <select
            className="min-h-11 flex-1 rounded border border-edge bg-card px-2"
            value={head.current_day_id}
            onChange={(e) => done(switchTo(id, e.target.value))}
          >
            {head.days.map((d) => (
              <option key={d.id} value={d.id}>
                {dayName(d)} ({t("history.restsOn", { count: rests?.by_day[d.id] ?? 0 })})
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}
