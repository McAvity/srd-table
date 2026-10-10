/**
 * The GM's controls for the fight: add monsters and characters, roll or set Initiative, start,
 * next turn, end; and the encounter's decision mode. Every control is an encounter action; a
 * refusal shows here. A combatant added while the map is in use is selected with the Place tool
 * on, so the next click on the map puts it there.
 */

import { useMemo, useState } from "react";
import type { MonsterDef } from "srd-rules-engine";
import { Icon } from "@/components/Icon";
import { Button, cx, Dialog, Reasons, Section } from "@/components/ui";
import { VirtualList } from "@/components/VirtualList";
import type { EncounterView } from "@/engine/facade";
import { t } from "@/i18n";
import { useTable } from "@/queries";
import { type EncounterRecord, useDocuments } from "@/store/documents";
import { useSettings } from "@/store/settings";
import { useTableUi } from "./tableUi";

/** After an add: if someone stands on the map, get the first newcomer placed next. */
function placeNewcomer(encounterId: string, before: readonly string[]) {
  const after = useDocuments.getState().encounters[encounterId]?.encounter.combatants ?? [];
  const newcomer = after.find((c) => !before.includes(c.id) && !c.position);
  if (!newcomer || !after.some((c) => c.position)) return;
  const ui = useTableUi.getState();
  ui.select(newcomer.id);
  ui.setTool("place");
}

export function CombatPanel({ record, view }: { record: EncounterRecord; view: EncounterView }) {
  const send = useDocuments((s) => s.encounterAction);
  const [reasons, setReasons] = useState<readonly string[] | null>(null);
  const [adding, setAdding] = useState<"monster" | "character" | null>(null);
  const [group, setGroup] = useState(true);
  const { encounter } = record;
  const started = encounter.round > 0;

  async function act(action: Parameters<typeof send>[1]) {
    const result = await send(record.id, action);
    setReasons(result.ok ? null : result.reasons);
  }

  return (
    <Section title={t("table.combat")}>
      <Reasons reasons={reasons} className="mb-2" />
      <div className="flex flex-wrap gap-1.5">
        {!started ? (
          <Button variant="primary" icon="swords" onClick={() => void act({ type: "start" })}>
            {t("table.start")}
          </Button>
        ) : (
          <>
            <Button variant="primary" icon="next" onClick={() => void act({ type: "next_turn" })}>
              {t("table.next")}
            </Button>
            <Button variant="danger" icon="flag" onClick={() => void act({ type: "end" })}>
              {t("table.end")}
            </Button>
          </>
        )}
        <Button icon="bolt" onClick={() => void act({ type: "roll_initiative", group })}>
          {t("table.rollInitiative")}
        </Button>
      </div>
      <label className="mt-2 flex items-center gap-2 text-sm text-ink-muted">
        <input
          type="checkbox"
          className="accent-[var(--blue)]"
          checked={group}
          onChange={(e) => setGroup(e.target.checked)}
        />
        {t("table.groupInitiative")}
      </label>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button size="sm" icon="plus" onClick={() => setAdding("monster")}>
          {t("table.addMonster")}
        </Button>
        <Button size="sm" icon="users" onClick={() => setAdding("character")}>
          {t("table.addCharacter")}
        </Button>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <span className="text-ink-muted">{t("table.decisions")}</span>
        <select
          className="field w-auto"
          value={encounter.decisions}
          onChange={(e) =>
            void act({ type: "set_decisions", mode: e.target.value as "ask" | "auto" })
          }
        >
          <option value="ask">{t("table.decisionsAsk")}</option>
          <option value="auto">{t("table.decisionsAuto")}</option>
        </select>
      </label>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <span className="text-ink-muted">{t("table.positions")}</span>
        <select
          className="field w-auto"
          value={encounter.positions}
          onChange={(e) =>
            void act({
              type: "set_positions",
              mode: e.target.value as "optional" | "required",
            })
          }
        >
          <option value="optional">{t("table.positionsOptional")}</option>
          <option value="required">{t("table.positionsRequired")}</option>
        </select>
      </label>
      {adding === "monster" && <AddMonster record={record} onClose={() => setAdding(null)} />}
      {adding === "character" && (
        <AddCharacter record={record} view={view} onClose={() => setAdding(null)} />
      )}
    </Section>
  );
}

function AddMonster({ record, onClose }: { record: EncounterRecord; onClose: () => void }) {
  const send = useDocuments((s) => s.encounterAction);
  const decisions = useSettings((s) => s.settings.monster_decisions);
  const { data: monsters } = useTable<MonsterDef>("monsters");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<MonsterDef | null>(null);
  const [count, setCount] = useState("1");
  const [rollHp, setRollHp] = useState(false);
  const [inLair, setInLair] = useState(false);
  const [side, setSide] = useState(t("table.sideEnemies"));
  const [reasons, setReasons] = useState<readonly string[] | null>(null);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...(monsters ?? [])]
      .filter((m) => !q || m.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [monsters, query]);
  const n = Math.max(1, Math.min(20, Number.parseInt(count, 10) || 1));

  async function add() {
    if (!picked) return;
    const action = {
      type: "add_monster" as const,
      monster: picked.id,
      side,
      decisions,
      ...(rollHp ? { roll_hp: true } : {}),
      ...(inLair ? { in_lair: true } : {}),
    };
    const before = record.encounter.combatants.map((c) => c.id);
    const result = await send(
      record.id,
      Array.from({ length: n }, () => action),
    );
    if (result.ok) {
      placeNewcomer(record.id, before);
      onClose();
    } else setReasons(result.reasons);
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("table.addMonster")}
      wide
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" icon="plus" disabled={!picked} onClick={() => void add()}>
            {t("common.add")}
          </Button>
        </>
      }
    >
      <Reasons reasons={reasons} className="mb-2" />
      <label className="mb-2 flex items-center gap-2">
        <Icon name="search" className="text-ink-muted" />
        <span className="sr-only">{t("table.monsterSearch")}</span>
        <input
          className="field"
          type="search"
          placeholder={t("table.monsterSearch")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="grid gap-3 md:grid-cols-[1fr_16rem]">
        <VirtualList
          items={list}
          estimate={44}
          className="h-[22rem] rounded border border-edge"
          label={t("table.addMonster")}
          getKey={(m) => m.id}
          render={(m) => (
            <button
              type="button"
              aria-pressed={picked?.id === m.id}
              onClick={() => setPicked(m)}
              className={cx(
                "flex w-full items-baseline gap-2 border-b border-edge/60 px-2 py-2 text-left hover:bg-card-2",
                picked?.id === m.id && "bg-hl text-hl-ink",
              )}
            >
              <span className="flex-1">{m.name}</span>
              <span className="text-[13px] text-ink-muted">
                CR {m.cr} · {m.size} {m.creature_type}
              </span>
            </button>
          )}
        />
        <div className="space-y-2 text-sm">
          {picked && (
            <p>
              <strong className="font-display text-lg text-ink">{picked.name}</strong>
              <br />
              AC {picked.armor_class} · HP {picked.hit_points} ({picked.hit_dice}) · CR {picked.cr}
            </p>
          )}
          <label className="flex items-center gap-2">
            {t("sheet.amount")}
            <input
              className="field w-16"
              inputMode="numeric"
              value={count}
              onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </label>
          <label className="flex items-center gap-2">
            {t("table.side")}
            <input className="field" value={side} onChange={(e) => setSide(e.target.value)} />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="accent-[var(--blue)]"
              checked={rollHp}
              onChange={(e) => setRollHp(e.target.checked)}
            />
            {t("table.rollHp")}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="accent-[var(--blue)]"
              checked={inLair}
              onChange={(e) => setInLair(e.target.checked)}
            />
            {t("table.inLair")}
          </label>
        </div>
      </div>
    </Dialog>
  );
}

function AddCharacter({
  record,
  view,
  onClose,
}: {
  record: EncounterRecord;
  view: EncounterView;
  onClose: () => void;
}) {
  const send = useDocuments((s) => s.encounterAction);
  const characters = useDocuments((s) => s.characters);
  const decisions = useSettings((s) => s.settings.character_decisions);
  const [reasons, setReasons] = useState<readonly string[] | null>(null);
  const inFight = new Set(view.combatants.map((c) => c.character).filter(Boolean));
  const list = Object.values(characters).sort((a, b) => a.build.name.localeCompare(b.build.name));

  async function add(id: string) {
    const before = record.encounter.combatants.map((c) => c.id);
    const result = await send(record.id, {
      type: "add_character",
      character: id,
      side: t("table.sideParty"),
      decisions,
    });
    setReasons(result.ok ? null : result.reasons);
    if (result.ok) placeNewcomer(record.id, before);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t("table.addCharacter")}>
      <Reasons reasons={reasons} className="mb-2" />
      <ul className="space-y-1.5">
        {list.map((c) => (
          <li key={c.id}>
            <Button
              className="w-full !justify-start"
              icon={inFight.has(c.id) ? "check" : "user"}
              on={inFight.has(c.id)}
              onClick={() => void add(c.id)}
            >
              {c.build.name || t("common.unnamed")}
            </Button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
