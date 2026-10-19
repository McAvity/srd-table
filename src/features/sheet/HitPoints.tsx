/**
 * Hit points and what's on the character right now: damage, healing and Temporary HP, death
 * saves, conditions and Exhaustion, Concentration, Heroic Inspiration; and the rests.
 */

import { useEffect, useRef, useState } from "react";
import type { ConditionDef, PlayAction, PlaySheet, RollResult } from "srd-rules-engine";
import { Explain } from "@/components/Explain";
import { Icon } from "@/components/Icon";
import { Button, cx, Dialog, Gems, HpBar, Reasons, Section } from "@/components/ui";
import { engine } from "@/engine/client";
import { damageTypes } from "@/engine/constants";
import { t } from "@/i18n";
import { titleCase } from "@/lib/format";
import { useTable } from "@/queries";
import { type CharacterRecord, useDocuments } from "@/store/documents";
import { type RecordVersion, useRolls, versionOf } from "@/store/rolls";
import { useUi } from "@/store/ui";
import { usePlay, usePlayResult } from "./usePlay";

export function HitPointsPanel({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, reasons: actReasons, busy: acting } = usePlay(id);
  // A death save is rolled by the engine and remembered, so Heroic Inspiration can redo it.
  const { run, reasons: saveReasons, busy: saving } = usePlayResult();
  const deathSave = useDocuments((s) => s.deathSave);
  const reasons = actReasons ?? saveReasons;
  const busy = acting || saving;
  const { play } = sheet;
  const [amount, setAmount] = useState("");
  const [damageType, setDamageType] = useState("");
  const n = Number.parseInt(amount, 10);
  const valid = Number.isInteger(n) && n >= 0;

  return (
    <>
      <Section title={t("sheet.hitPoints")}>
        <div className="flex items-baseline gap-2">
          <span className="font-display text-4xl font-bold tabular-nums">{play.hp.current}</span>
          <span className="text-ink-muted">/</span>
          {sheet.max_hp ? (
            <span className="font-display text-2xl">
              <ExplainMax sheet={sheet} />
            </span>
          ) : (
            <span>{play.hp.max}</span>
          )}
          {play.hp.temp > 0 && (
            <span className="ml-auto rounded bg-blue/20 px-2 text-blue">
              +{play.hp.temp} {t("sheet.temp")}
            </span>
          )}
        </div>
        <HpBar
          hp={play.hp.current}
          max={play.hp.max}
          temp={play.hp.temp}
          bloodied={play.hp.bloodied}
          className="mt-1 mb-3"
        />
        {play.hp.bloodied && !play.dying && !play.dead && (
          <p className="mb-2 font-semibold text-red">{t("table.bloodied")}</p>
        )}
        {(play.dying || play.stable || play.dead) && (
          <p className={cx("mb-2 font-semibold", play.dead ? "text-red" : "text-orange")}>
            {play.dead ? t("sheet.dead") : play.stable ? t("sheet.stable") : t("sheet.dying")}
          </p>
        )}
        <Reasons reasons={reasons} className="mb-2" />
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="sr-only">{t("sheet.amount")}</span>
              <input
                className="field"
                inputMode="numeric"
                placeholder={t("sheet.amount")}
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
              />
            </label>
            <label className="flex-1">
              <span className="sr-only">{t("sheet.damageType")}</span>
              <select
                className="field"
                value={damageType}
                onChange={(e) => setDamageType(e.target.value)}
              >
                <option value="">{t("sheet.untyped")}</option>
                {damageTypes().map((d) => (
                  <option key={d} value={d}>
                    {titleCase(d)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <Button
              size="sm"
              variant="danger"
              icon="swords"
              disabled={!valid || busy}
              onClick={async () => {
                const ok = await act({
                  type: "damage",
                  amount: n,
                  ...(damageType ? { damage_type: damageType } : {}),
                });
                if (ok) setAmount("");
              }}
            >
              {t("sheet.damage")}
            </Button>
            <Button
              size="sm"
              icon="heart"
              disabled={!valid || busy}
              onClick={async () => {
                if (await act({ type: "heal", amount: n })) setAmount("");
              }}
            >
              {t("sheet.heal")}
            </Button>
            <Button
              size="sm"
              icon="shield"
              disabled={!valid || busy}
              onClick={async () => {
                if (await act({ type: "set_temp_hp", amount: n })) setAmount("");
              }}
            >
              {t("sheet.temp")}
            </Button>
          </div>
        </form>
        {(play.dying || play.death_saves.successes > 0 || play.death_saves.failures > 0) && (
          <div className="mt-3 space-y-1.5 border-t border-edge pt-3">
            <h3 className="font-semibold">{t("sheet.deathSaves")}</h3>
            <div className="flex items-center gap-2 text-sm">
              <span className="w-20 text-ink-muted">{t("sheet.successes")}</span>
              <Gems total={3} spent={3 - play.death_saves.successes} label={t("sheet.successes")} />
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="w-20 text-ink-muted">{t("sheet.failures")}</span>
              <Gems total={3} spent={3 - play.death_saves.failures} label={t("sheet.failures")} />
            </div>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                icon="d20"
                disabled={busy}
                onClick={() => void run(() => deathSave(id))}
              >
                {t("sheet.rollDeathSave")}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void act({ type: "stabilize" })}>
                {t("sheet.stabilize")}
              </Button>
            </div>
          </div>
        )}
      </Section>
      <ConditionsPanel id={id} sheet={sheet} />
    </>
  );
}

function ExplainMax({ sheet }: { sheet: PlaySheet }) {
  if (!sheet.max_hp) return <>{sheet.play.hp.max}</>;
  return <Explain label={t("summary.hp")} total={sheet.max_hp.total} parts={sheet.max_hp.parts} />;
}

function ConditionsPanel({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, reasons, busy } = usePlay(id);
  const { data: conditions } = useTable<ConditionDef>("conditions", { character: id });
  const { play } = sheet;
  const active = new Set(play.conditions.map((c) => c.id));
  return (
    <Section title={t("sheet.conditions")}>
      <Reasons reasons={reasons} className="mb-2" />
      {play.conditions.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {play.conditions.map((c) => (
            <li key={c.id}>
              <span
                className={cx("btn btn-sm", c.implied && "opacity-70")}
                title={c.description.split("\n")[0]}
              >
                <ConditionMedal />
                {c.name}
                {!c.implied && (
                  <button
                    type="button"
                    className="ml-1 text-ink-muted hover:text-red"
                    aria-label={`${t("common.remove")}: ${c.name}`}
                    disabled={busy}
                    onClick={() => void act({ type: "remove_condition", condition: c.id })}
                  >
                    <Icon name="x" size={14} />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <label className="flex items-center gap-2">
        <span className="sr-only">{t("sheet.addCondition")}</span>
        <select
          className="field"
          value=""
          disabled={busy}
          onChange={(e) => {
            if (e.target.value) void act({ type: "add_condition", condition: e.target.value });
          }}
        >
          <option value="">{t("sheet.addCondition")}</option>
          {(conditions ?? [])
            .filter((c) => c.id !== "exhaustion" && !active.has(c.id))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
      <div className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm">
        <span className="text-ink-muted">{t("sheet.exhaustion")}</span>
        <select
          className="field max-w-[6rem]"
          aria-label={t("sheet.exhaustion")}
          value={play.exhaustion}
          disabled={busy}
          onChange={(e) => void act({ type: "set_exhaustion", level: Number(e.target.value) })}
        >
          {[0, 1, 2, 3, 4, 5, 6].map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <span className="text-ink-muted">{t("sheet.concentration")}</span>
        <span className="flex items-center gap-2">
          {play.concentration ? (
            <>
              <Icon name="concentration" size={16} className="text-purple" />
              <span className="flex-1">{play.concentration}</span>
              <Button
                size="sm"
                icon="x"
                iconOnly
                label={t("sheet.endConcentration")}
                disabled={busy}
                onClick={() => void act({ type: "set_concentration", spell: null })}
              />
            </>
          ) : (
            <span className="text-ink-faint">{t("sheet.concentrationNone")}</span>
          )}
        </span>
        <span className="text-ink-muted">{t("sheet.inspiration")}</span>
        <span>
          <Button
            size="sm"
            icon="star"
            on={play.heroic_inspiration}
            aria-pressed={play.heroic_inspiration}
            disabled={busy}
            onClick={() => void act({ type: "set_inspiration", value: !play.heroic_inspiration })}
          >
            {play.heroic_inspiration ? t("sheet.on") : t("sheet.off")}
          </Button>
        </span>
      </div>
    </Section>
  );
}

/** A condition as a round medallion (red when it hinders); the name is next to it or in a label. */
/**
 * A condition as a ring, like the coloured rings slipped onto a miniature: alone next to the
 * condition's name, or as a chip with the name (`label`) where space is short.
 */
export function ConditionMedal({ label }: { label?: string }) {
  const ring = (
    <span
      className="inline-block h-3 w-3 flex-none rounded-full border-[2.5px] border-red"
      aria-hidden="true"
    />
  );
  if (!label) return ring;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border-[1.5px] border-red py-px pr-2 pl-1 text-[13px] leading-tight">
      {ring}
      {label}
    </span>
  );
}

/**
 * Short and Long Rests. A Short Rest spends Hit Point Dice one at a time: each is the engine's
 * roll (shown in the tray), the dialog shows the engine's preview of the rest so far (nothing
 * saved), and the player decides on the next die after seeing it; Heroic Inspiration can reroll
 * the last die before confirming. Confirm is one `short_rest` with every die rolled, so what a
 * Short Rest gives back comes once; Cancel saves nothing (contract actions.md §7.1).
 *
 * The dialog's steps (a die, the reroll, the preview) run one after another, each applied whole
 * (dice and preview together) and only in the opening it was asked in: closing or opening the
 * dialog drops the answers still to come. A rest is made on the record as it was when it began
 * (`rev`/`gen`): changed meanwhile (another action, an import replacing it), the rest starts again
 * from it, and Confirm is refused for the old one (`playAction`'s `at`). Nothing is confirmed while
 * a step is pending.
 */
interface RestDie {
  readonly die: number;
  readonly roll: RollResult;
}
interface RestDraft {
  readonly kind: "short" | "long";
  /** The record the rest is made on. */
  readonly at: RecordVersion;
  readonly rolled: readonly RestDie[];
  readonly heroic: boolean;
  readonly preview: { readonly hp: number; readonly max: number } | null;
  readonly problem: readonly string[] | null;
  /** Started again because the record changed. */
  readonly restarted: boolean;
}
/** A step's result: the dice so far (and a die to show), or the engine's reasons. */
type RestStep =
  | { readonly rolled: readonly RestDie[]; readonly heroic: boolean; readonly shown?: RollResult }
  | { readonly problem: readonly string[] };

const sameVersion = (record: CharacterRecord, at: RecordVersion) => {
  const now = versionOf(record);
  return now.rev === at.rev && now.gen === at.gen;
};
const restActions = (dice: readonly RestDie[], spent: boolean): PlayAction[] => [
  ...(spent ? [{ type: "spend_inspiration" as const }] : []),
  { type: "short_rest", hit_dice: dice.map((d) => ({ die: d.die, roll: d.roll.total })) },
];

export function RestButtons({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, reasons, busy, clear } = usePlay(id);
  const record = useDocuments((s) => s.characters[id]);
  const [draft, setDraft] = useState<RestDraft | null>(null);
  const [pending, setPending] = useState(0);
  // The draft as the steps see it, the opening the dialog is in (each opening and closing a new
  // one), the steps of this opening one after another, and a Confirm under way.
  const current = useRef<RestDraft | null>(null);
  const session = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const confirming = useRef(false);
  // A die or reroll asked and not answered yet: another click is ignored (a double click is one).
  const asking = useRef(false);
  const put = (next: RestDraft | null) => {
    current.current = next;
    setDraft(next);
  };
  const newSession = () => {
    session.current += 1;
    queue.current = Promise.resolve();
    confirming.current = false;
    asking.current = false;
    setPending(0);
  };
  const close = () => {
    newSession();
    put(null);
    clear();
  };
  const begin = (kind: "short" | "long", restarted = false) => {
    const now = useDocuments.getState().characters[id];
    newSession();
    if (!restarted) clear();
    if (!now) return put(null);
    const at = versionOf(now);
    put({ kind, at, rolled: [], heroic: false, preview: null, problem: null, restarted });
    // The rest with no die yet: what it gives back as it is.
    if (kind === "short") step(async () => ({ rolled: [], heroic: false }));
  };
  /** A step of this opening, after the ones before it; applied only if still this opening. */
  function step(make: (draft: RestDraft, on: CharacterRecord) => Promise<RestStep>, asked = false) {
    if (asked && asking.current) return;
    const mine = session.current;
    const live = () => session.current === mine;
    if (asked) asking.current = true;
    setPending((n) => n + 1);
    queue.current = queue.current.then(async () => {
      try {
        const draft = current.current;
        const on = useDocuments.getState().characters[id];
        if (!live() || !draft || !on || !sameVersion(on, draft.at)) return;
        const made = await make(draft, on);
        if (!live()) return;
        if ("problem" in made) return put({ ...draft, problem: made.problem });
        const f = engine();
        const after = await f.applyPlayAction(
          on.build,
          on.state,
          restActions(made.rolled, made.heroic),
          on.content,
        );
        const view = after.ok ? await f.playSheet(on.build, after.state, on.content) : null;
        const still = useDocuments.getState().characters[id];
        if (!live() || !still || !sameVersion(still, draft.at)) return;
        if (made.shown) {
          useUi.getState().showDice([{ kind: "roll", who: on.build.name ?? "", roll: made.shown }]);
          // A later result of the character: its last roll can't be changed any more (§5.5).
          useRolls.getState().forget(id);
        }
        put({
          ...draft,
          rolled: made.rolled,
          heroic: made.heroic,
          preview: view ? { hp: view.sheet.play.hp.current, max: view.sheet.play.hp.max } : null,
          problem: after.ok ? null : after.reasons,
        });
      } catch (error) {
        const draft = current.current;
        if (live() && draft) put({ ...draft, problem: [String(error)] });
      } finally {
        if (live()) {
          if (asked) asking.current = false;
          setPending((n) => n - 1);
        }
      }
    });
  }
  const rollDie = (die: number) =>
    step(async (d) => {
      const r = await engine().roll(`1d${die}`);
      if (!r.ok) return { problem: r.reasons };
      return { rolled: [...d.rolled, { die, roll: r.roll }], heroic: d.heroic, shown: r.roll };
    }, true);
  const rerollLast = () =>
    step(async (d, on) => {
      const last = d.rolled.at(-1);
      if (!last) return { problem: [t("errors.rollNotApplicable")] };
      const r = await engine().heroicReroll(
        on.build,
        on.state,
        { kind: "single", roll: last.roll, die: 0 },
        on.content,
      );
      if (!r.ok) return { problem: r.reasons };
      const again = r.roll as RollResult;
      return {
        rolled: [...d.rolled.slice(0, -1), { die: last.die, roll: again }],
        heroic: true,
        shown: again,
      };
    }, true);
  // The record changed since the rest began (and not by its own Confirm): start it again from it.
  const stale = draft !== null && (!record || !sameVersion(record, draft.at));
  // biome-ignore lint/correctness/useExhaustiveDependencies: restarts only when it goes stale
  useEffect(() => {
    if (!stale || busy || confirming.current || !draft) return;
    if (!record) close();
    else begin(draft.kind, true);
  }, [stale, busy]);
  const rolled = draft?.rolled ?? [];
  const spentOf = (die: number) => rolled.filter((d) => d.die === die).length;
  const waiting = pending > 0 || stale;
  const open = draft?.kind ?? null;
  return (
    <>
      <Button size="sm" icon="hourglass" onClick={() => begin("short")}>
        {t("sheet.shortRest")}
      </Button>
      <Button size="sm" icon="moon" onClick={() => begin("long")}>
        {t("sheet.longRest")}
      </Button>
      <Dialog
        open={open !== null}
        onOpenChange={(o) => {
          if (!o) close();
        }}
        title={open === "long" ? t("sheet.longRest") : t("sheet.shortRest")}
        footer={
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              icon={open === "long" ? "moon" : "hourglass"}
              disabled={busy || waiting || (open === "short" && draft?.problem != null)}
              onClick={async () => {
                const d = current.current;
                if (!d || confirming.current) return;
                confirming.current = true;
                const ok = await act(
                  d.kind === "long" ? { type: "long_rest" } : restActions(d.rolled, d.heroic),
                  d.at,
                );
                if (ok) return close();
                confirming.current = false;
                const now = useDocuments.getState().characters[id];
                if (!now || !sameVersion(now, d.at)) begin(d.kind, true);
              }}
            >
              {t("common.confirm")}
            </Button>
          </>
        }
      >
        <Reasons reasons={reasons ?? draft?.problem ?? null} className="mb-2" />
        {draft?.restarted && (
          <p className="mb-2 text-sm text-ink-muted" role="status">
            {t("sheet.restRestarted")}
          </p>
        )}
        {open === "short" && (
          <div className="space-y-2">
            <p className="text-sm text-ink-muted">{t("sheet.shortRestSequential")}</p>
            {sheet.play.hit_dice.map((d) => {
              const left = d.total - d.spent - spentOf(d.die);
              return (
                <div key={d.die} className="flex items-center gap-3">
                  <span className="w-12 font-semibold">d{d.die}</span>
                  <span className="text-sm text-ink-muted">
                    {t("common.left", { left, total: d.total })}
                  </span>
                  <Button
                    size="sm"
                    icon="d20"
                    className="ml-auto"
                    disabled={busy || waiting || left <= 0}
                    onClick={() => rollDie(d.die)}
                  >
                    {t("sheet.spendHitDie", { die: d.die })}
                  </Button>
                </div>
              );
            })}
            {rolled.length > 0 && (
              <p className="text-sm" data-testid="rest-dice">
                {t("sheet.hitDiceRolled", {
                  dice: rolled.map((d) => `d${d.die}: ${d.roll.total}`).join(", "),
                })}
              </p>
            )}
            {draft?.preview && (
              <p className="text-sm font-semibold" data-testid="rest-preview">
                {t("sheet.restPreview", { hp: draft.preview.hp, max: draft.preview.max })}
              </p>
            )}
            {rolled.length > 0 && sheet.play.heroic_inspiration && !draft?.heroic && (
              <Button size="sm" disabled={busy || waiting} onClick={() => rerollLast()}>
                {t("sheet.heroicLastHitDie")}
              </Button>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
