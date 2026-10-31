/**
 * Characters: the list, create, duplicate, delete. kenli F-011 T04 (AC-01): ONE export — the full
 * copy (`srd-table.local-copy/2`: build, state, whole journal, exact packs, portrait) — and ONE
 * import, of such a copy, from a file or a URL; it always makes a new character. The old raw
 * build/state and character transfer exports and imports are gone (packs: Settings; encounters with
 * their party: Encounters). kenli F-011 T08: "New character" asks for the content when packs were
 * imported in Settings (the campaign's, or one installed pack's exact context).
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { OptionButton } from "@/components/OptionButton";
import { Portrait } from "@/components/Portrait";
import { Button, Dialog, Empty, HpBar, PageTitle, Reasons } from "@/components/ui";
import { t, tn } from "@/i18n";
import { installedPackContext } from "@/import/export";
import { contentLabel } from "@/import/plan";
import type { ContentContext } from "@/lib/canonical";
import { entryCount } from "@/persistence/history";
import { useInstalledPacks, usePlayView } from "@/queries";
import { type CharacterRecord, useDocuments } from "@/store/documents";
import { LocalCopyExport } from "./LocalCopyExport";
import { LocalCopyImport, LocalCopyLast } from "./LocalCopyImport";

export function CharactersPage() {
  const characters = useDocuments((s) => s.characters);
  const create = useDocuments((s) => s.createCharacter);
  const navigate = useNavigate();
  const [loadingCopy, setLoadingCopy] = useState(false);
  const list = Object.values(characters).sort((a, b) => b.updated - a.updated);

  const installed = useInstalledPacks();
  const ownPacks = (installed.data ?? []).filter((p) => !p.bundled);
  const [choosing, setChoosing] = useState(false);
  const [createReasons, setCreateReasons] = useState<string[] | null>(null);

  async function onCreate(content?: ContentContext) {
    const id = await create(content);
    setChoosing(false);
    await navigate({ to: "/characters/$id/build", params: { id }, search: { step: "class" } });
  }
  // kenli F-011 T08: with packs imported in Settings, the new character's content is asked: the
  // campaign's (Settings), or one installed pack's exact context (with the packs it requires).
  async function onCreateWith(key: string) {
    const content = await installedPackContext(key);
    if (!content) return setCreateReasons([t("characters.newContentGone")]);
    if ("ambiguous" in content)
      return setCreateReasons([t("settings.packAmbiguous", { id: content.ambiguous })]);
    setCreateReasons(null);
    await onCreate(content);
  }

  return (
    <div className="mx-auto max-w-6xl p-4 @min-[600px]:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <PageTitle sub={t("characters.sub")}>{t("characters.title")}</PageTitle>
        </div>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => (ownPacks.length ? setChoosing(true) : void onCreate())}
        >
          {t("characters.new")}
        </Button>
        <Button icon="upload" onClick={() => setLoadingCopy(true)} data-testid="local-copy-open">
          {t("localCopy.import")}
        </Button>
      </div>
      <Dialog
        open={choosing}
        onOpenChange={(open) => {
          setChoosing(open);
          if (!open) setCreateReasons(null);
        }}
        title={t("characters.newContentTitle")}
        description={t("characters.newContentHint")}
      >
        <Reasons reasons={createReasons} className="mb-2" />
        <ul className="grid gap-1.5" data-testid="new-character-content">
          <li>
            <OptionButton reason={null} onClick={() => void onCreate()}>
              {t("characters.newContentCampaign")}
            </OptionButton>
          </li>
          {ownPacks.map((p) => (
            <li key={p.key}>
              <OptionButton
                reason={null}
                onClick={() => void onCreateWith(p.key)}
                detail={t("characters.newContentPackDetail", { sha: p.ref.sha256.slice(0, 12) })}
              >
                {t("characters.newContentPack", { id: p.ref.id, version: p.ref.version ?? "" })}
              </OptionButton>
            </li>
          ))}
        </ul>
      </Dialog>
      <LocalCopyImport open={loadingCopy} onOpenChange={setLoadingCopy} />
      <LocalCopyLast />
      {list.length === 0 ? (
        <div className="panel">
          <Empty icon="sheet">{t("characters.empty")}</Empty>
        </div>
      ) : (
        <>
          <p className="mb-2 text-sm text-ink-muted">{tn("characters.count", list.length)}</p>
          <ul className="grid gap-3 @min-[600px]:grid-cols-2 @min-[960px]:grid-cols-3">
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

function CharacterCard({ record }: { record: CharacterRecord }) {
  const { data } = usePlayView(record.id);
  const duplicate = useDocuments((s) => s.duplicateCharacter);
  const remove = useDocuments((s) => s.deleteCharacter);
  const [confirm, setConfirm] = useState(false);
  const [copying, setCopying] = useState(false);
  // kenli F-006 §7.5: the journal on this device goes with the character; say how much.
  const [entries, setEntries] = useState<number | null>(null);
  const name = record.build.name || t("common.unnamed");
  const sheet = data?.sheet;
  const classes = sheet?.classes.map((c) => `${c.name} ${c.level}`).join(" / ");

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
            label={t("localCopy.export")}
            onClick={() => setCopying(true)}
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
      <LocalCopyExport recordId={record.id} name={name} open={copying} onOpenChange={setCopying} />
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
