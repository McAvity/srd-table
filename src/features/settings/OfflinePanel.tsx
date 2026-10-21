/**
 * kenli F-007 T04: "Offline play" in Settings — the readiness of one character or one encounter
 * (its world and whole party), each item with its state, and the explicit preparation (also the
 * retry), its Cancel, and "Reload to finish" once this release is prepared but not yet in control
 * of the page. The storage protection is shown on its own. A missing exact pack is brought with the
 * existing Import… (its file or URL); nothing is downloaded beyond what the target needs.
 */

import { useState } from "react";
import { Button, Section, Spinner } from "@/components/ui";
import { type MessageKey, t } from "@/i18n";
import { en } from "@/i18n/en";
import { type ReadinessItem, type Target, useReadiness } from "@/offline/readiness";
import { useDocuments } from "@/store/documents";

const has = (key: string): key is MessageKey => Object.hasOwn(en, key);

/** One item of a readiness list, in the app's words. */
export function itemText(item: ReadinessItem, nameOf: (id: string) => string): string {
  const what =
    item.kind === "app"
      ? t("offline.item.app", { id: item.id })
      : item.kind === "pack"
        ? item.id === "campaign"
          ? t("offline.item.packCampaign")
          : t("offline.item.pack", { id: item.id.replace(/#(.{12}).*$/, " ($1)") })
        : item.kind === "party"
          ? t("offline.item.party", { name: nameOf(item.id) })
          : t(`offline.item.${item.kind}`);
  const state = t(`offline.state.${item.status}`);
  const code = item.detail?.split(":")[0] ?? "";
  const detail = item.detail
    ? has(`offline.detail.${code}`)
      ? t(`offline.detail.${code}` as MessageKey)
      : item.detail
    : "";
  return `${what}: ${state}${detail ? ` — ${detail}` : ""}`;
}

export function OfflinePanel() {
  const characters = useDocuments((s) => s.characters);
  const encounters = useDocuments((s) => s.encounters);
  const first = Object.keys(characters)[0];
  const [choice, setChoice] = useState<string>(first ? `character:${first}` : "");
  const [kind, id] = choice.split(":") as ["character" | "encounter", string | undefined];
  const target: Target | null = id ? { kind, id } : null;
  const { readiness, status, busy, check, prepare, cancel } = useReadiness(target);
  const nameOf = (cid: string) => characters[cid]?.build.name || t("common.unnamed");
  const needsReload = readiness?.items.some((i) => i.detail === "reload_to_finish");
  const storage = readiness?.storage.persisted;

  return (
    <Section title={t("offline.title")}>
      <p className="mb-2 text-sm text-ink-muted">{t("offline.hint")}</p>
      <p className="mb-3 text-sm text-ink-muted">{t("offline.howto")}</p>
      <label className="mb-3 flex flex-col gap-1 text-sm">
        <span className="font-semibold">{t("offline.target")}</span>
        <select
          className="field"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          data-testid="offline-target"
        >
          <optgroup label={t("offline.targetCharacters")}>
            {Object.values(characters).map((c) => (
              <option key={c.id} value={`character:${c.id}`}>
                {c.build.name || t("common.unnamed")}
              </option>
            ))}
          </optgroup>
          <optgroup label={t("offline.targetEncounters")}>
            {Object.values(encounters).map((e) => (
              <option key={e.id} value={`encounter:${e.id}`}>
                {e.name}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      {target && (
        <div className="space-y-2" data-testid="offline-readiness">
          <p className="font-semibold" data-testid="offline-status" data-status={status ?? ""}>
            {status ? t(`offline.status.${status}`) : t("offline.status.checking")}
          </p>
          {busy && <Spinner label={t(`offline.status.${busy}`)} />}
          {readiness && (
            <ul className="space-y-0.5 text-sm" aria-label={t("offline.title")}>
              {readiness.items.map((item, i) => (
                <li
                  key={`${item.kind}-${item.id}-${i}`}
                  data-testid="offline-item"
                  data-kind={item.kind}
                  data-state={item.status}
                  className={item.status === "ok" ? "" : "text-red"}
                >
                  {itemText(item, nameOf)}
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm" data-testid="offline-storage" data-persisted={storage ?? ""}>
            {t("offline.storage", {
              state: storage ? t(`offline.storage.${storage}`) : t("offline.storage.notAsked"),
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            {busy === "preparing" ? (
              <Button onClick={cancel}>{t("offline.cancel")}</Button>
            ) : (
              <Button variant="primary" icon="download" onClick={() => void prepare()}>
                {t("offline.prepare")}
              </Button>
            )}
            {readiness?.status === "failed" || readiness?.status === "incomplete" ? (
              <Button onClick={() => void prepare()} disabled={busy === "preparing"}>
                {t("offline.retry")}
              </Button>
            ) : null}
            <Button onClick={() => void check()} disabled={busy !== null}>
              {t("offline.check")}
            </Button>
            {needsReload && (
              <Button variant="primary" onClick={() => location.reload()}>
                {t("offline.reload")}
              </Button>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}
