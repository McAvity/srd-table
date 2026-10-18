/**
 * Encounters: the list, create, import (files or a URL, with the characters they need: kenli
 * F-008) and export (the encounter document's JSON, or transfers with its party), delete.
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Button, Dialog, Empty, PageTitle } from "@/components/ui";
import { ImportDialog } from "@/features/import/ImportDialog";
import { t, tn } from "@/i18n";
import { exportEncounter } from "@/import/export";
import { contentLabel } from "@/import/plan";
import { downloadJson } from "@/lib/files";
import { fileSlug } from "@/lib/format";
import { installationId } from "@/persistence/sync";
import { type EncounterRecord, useDocuments } from "@/store/documents";

export function EncountersPage() {
  const encounters = useDocuments((s) => s.encounters);
  const create = useDocuments((s) => s.createEncounter);
  const navigate = useNavigate();
  const [importing, setImporting] = useState(false);
  const list = Object.values(encounters).sort((a, b) => b.updated - a.updated);

  async function onCreate() {
    const id = await create(t("encounters.newName", { n: list.length + 1 }));
    await navigate({ to: "/encounters/$id", params: { id } });
  }

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <PageTitle sub={t("encounters.sub")}>{t("encounters.title")}</PageTitle>
        </div>
        <Button variant="primary" icon="plus" onClick={() => void onCreate()}>
          {t("encounters.new")}
        </Button>
        <Button icon="upload" onClick={() => setImporting(true)}>
          {t("import.open")}
        </Button>
      </div>
      <ImportDialog open={importing} onOpenChange={setImporting} />
      {list.length === 0 ? (
        <div className="panel">
          <Empty icon="table">{t("encounters.empty")}</Empty>
        </div>
      ) : (
        <ul className="space-y-2">
          {list.map((e) => (
            <li key={e.id}>
              <EncounterRow record={e} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EncounterRow({ record }: { record: EncounterRecord }) {
  const remove = useDocuments((s) => s.deleteEncounter);
  const [confirm, setConfirm] = useState(false);
  const { encounter } = record;
  return (
    <article className="panel flex flex-wrap items-center gap-3 p-3">
      <Icon name="swords" size={26} className="text-ink-muted" />
      <div className="min-w-0 flex-1">
        <Link
          to="/encounters/$id"
          params={{ id: record.id }}
          className="font-display text-xl text-ink hover:text-ink"
        >
          {record.name}
        </Link>
        <p className="text-sm text-ink-muted">
          {encounter.round > 0
            ? t("encounters.round", { round: encounter.round })
            : t("encounters.notStarted")}
          {" · "}
          {tn("encounters.combatants", encounter.combatants.length)}
          {" · "}
          {encounter.combatants.map((c) => c.name).join(", ")}
        </p>
        {record.content && (
          <p className="text-[13px] text-ink-muted">
            {t("characters.contentPinned", { content: contentLabel(record.content) ?? "" })}
          </p>
        )}
      </div>
      <Link to="/encounters/$id" params={{ id: record.id }} className="btn btn-sm">
        <Icon name="play" size={16} />
        {t("common.open")}
      </Link>
      <Button
        size="sm"
        icon="download"
        iconOnly
        label={t("common.export")}
        onClick={() => downloadJson(`${fileSlug(record.name, record.id)}.json`, encounter)}
      />
      <Button
        size="sm"
        icon="upload"
        iconOnly
        label={t("encounters.exportTransfer")}
        onClick={() =>
          void exportEncounter(record, useDocuments.getState().characters, installationId()).then(
            ({ encounter: env, party }) => {
              downloadJson(`${fileSlug(record.name, record.id)}.transfer.json`, env);
              for (const p of party) downloadJson(`${fileSlug(p.title, p.id)}.transfer.json`, p);
            },
          )
        }
      />
      <Button
        size="sm"
        variant="danger"
        icon="trash"
        iconOnly
        label={t("common.delete")}
        onClick={() => setConfirm(true)}
      />
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("common.delete")}
        description={t("common.reallyDelete", { name: record.name })}
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
