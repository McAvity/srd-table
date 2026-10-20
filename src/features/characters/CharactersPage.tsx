/**
 * Characters: the list, create, import (files or a URL, kenli F-008) and export (the documents'
 * JSON, or a transfer with their content's identity), duplicate, delete.
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Portrait } from "@/components/Portrait";
import { Button, Dialog, Empty, HpBar, PageTitle } from "@/components/ui";
import { ImportDialog } from "@/features/import/ImportDialog";
import { t, tn } from "@/i18n";
import { exportCharacter } from "@/import/export";
import { contentLabel } from "@/import/plan";
import { downloadJson } from "@/lib/files";
import { fileSlug } from "@/lib/format";
import { entryCount } from "@/persistence/history";
import { installationId } from "@/persistence/sync";
import { usePlayView } from "@/queries";
import { type CharacterRecord, useDocuments } from "@/store/documents";
import { useUi } from "@/store/ui";

export function CharactersPage() {
  const characters = useDocuments((s) => s.characters);
  const create = useDocuments((s) => s.createCharacter);
  const navigate = useNavigate();
  const [importing, setImporting] = useState(false);
  const list = Object.values(characters).sort((a, b) => b.updated - a.updated);

  async function onCreate() {
    const id = await create();
    await navigate({ to: "/characters/$id/build", params: { id }, search: { step: "class" } });
  }

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <PageTitle sub={t("characters.sub")}>{t("characters.title")}</PageTitle>
        </div>
        <Button variant="primary" icon="plus" onClick={onCreate}>
          {t("characters.new")}
        </Button>
        <Button icon="upload" onClick={() => setImporting(true)} title={t("characters.importHint")}>
          {t("import.open")}
        </Button>
      </div>
      <ImportDialog open={importing} onOpenChange={setImporting} />
      {list.length === 0 ? (
        <div className="panel">
          <Empty icon="sheet">{t("characters.empty")}</Empty>
        </div>
      ) : (
        <>
          <p className="mb-2 text-sm text-ink-muted">{tn("characters.count", list.length)}</p>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((c) => (
              <li key={c.id}>
                <CharacterCard record={c} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** kenli F-006: an export carries no history, days or counters; say so (it stays on this device). */
const localOnly = () => useUi.getState().toast([t("history.local")], "info", t("history.title"));

function CharacterCard({ record }: { record: CharacterRecord }) {
  const { data } = usePlayView(record.id);
  const duplicate = useDocuments((s) => s.duplicateCharacter);
  const remove = useDocuments((s) => s.deleteCharacter);
  const [confirm, setConfirm] = useState(false);
  // kenli F-006 §7.5: the journal on this device goes with the character; say how much.
  const [entries, setEntries] = useState<number | null>(null);
  const name = record.build.name || t("common.unnamed");
  const sheet = data?.sheet;
  const classes = sheet?.classes.map((c) => `${c.name} ${c.level}`).join(" / ");
  const slug = fileSlug(record.build.name, record.id);

  return (
    <article className="panel flex h-full gap-3 p-3">
      <Portrait id={record.id} name={name} size={72} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 className="truncate font-display text-xl text-ink">{name}</h2>
        <p className="text-sm text-ink-muted">
          {sheet && classes
            ? t("characters.levelClass", { level: sheet.level, classes })
            : t("characters.noClass")}
        </p>
        <p className="text-[13px] text-ink-muted" data-testid="content-label">
          {record.content
            ? t("characters.contentPinned", { content: contentLabel(record.content) ?? "" })
            : t("characters.contentCampaign")}
        </p>
        {sheet?.play && sheet.max_hp && (
          <div className="flex items-center gap-2 text-sm">
            <Icon name="heart" size={15} className="text-red" />
            <span className="tabular-nums">
              {sheet.play.hp.current} / {sheet.play.hp.max}
            </span>
            <HpBar
              hp={sheet.play.hp.current}
              max={sheet.play.hp.max}
              temp={sheet.play.hp.temp}
              bloodied={sheet.play.hp.bloodied}
              className="flex-1"
            />
          </div>
        )}
        <div className="mt-auto flex flex-wrap gap-1.5 pt-2">
          <Link
            to="/characters/$id/sheet"
            params={{ id: record.id }}
            search={{}}
            className="btn btn-sm"
          >
            <Icon name="sheet" size={16} />
            {t("characters.sheet")}
          </Link>
          <Link
            to="/characters/$id/build"
            params={{ id: record.id }}
            search={{}}
            className="btn btn-sm"
          >
            <Icon name="edit" size={16} />
            {t("characters.build")}
          </Link>
          <Button
            size="sm"
            icon="download"
            iconOnly
            label={t("characters.exportBuild")}
            onClick={() => {
              downloadJson(`${slug}.json`, record.build);
              localOnly();
            }}
          />
          <Button
            size="sm"
            icon="scroll"
            iconOnly
            label={t("characters.exportState")}
            onClick={() => {
              downloadJson(`${slug}.state.json`, record.state);
              localOnly();
            }}
          />
          <Button
            size="sm"
            icon="upload"
            iconOnly
            label={t("characters.exportTransfer")}
            onClick={() =>
              void exportCharacter(record, installationId()).then((env) => {
                downloadJson(`${slug}.transfer.json`, env);
                localOnly();
              })
            }
          />
          <Button
            size="sm"
            icon="copy"
            iconOnly
            label={t("common.duplicate")}
            onClick={() => void duplicate(record.id)}
          />
          <Button
            size="sm"
            variant="danger"
            icon="trash"
            iconOnly
            label={t("common.delete")}
            onClick={() => {
              setEntries(null);
              setConfirm(true);
              void entryCount(record.id).then(setEntries);
            }}
          />
        </div>
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("common.delete")}
        description={
          entries
            ? `${t("common.reallyDelete", { name })} ${t("characters.deleteHistory", { count: entries })}`
            : t("common.reallyDelete", { name })
        }
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>{t("common.cancel")}</Button>
            <Button variant="danger" icon="trash" onClick={() => remove(record.id)}>
              {t("common.delete")}
            </Button>
          </>
        }
      />
    </article>
  );
}
