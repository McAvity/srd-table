/** A character's portrait (uploaded by the player), or a medallion with initials. */

import { useEffect, useRef, useState } from "react";
import { t } from "@/i18n";
import { en } from "@/i18n/en";
import { PORTRAIT_MIMES } from "@/lib/image";
import { type PortraitResult, usePortraits } from "@/store/portraits";
import { Button, cx } from "./ui";

export function Portrait({
  id,
  name,
  size = 64,
  round = false,
  className,
}: {
  id: string | null;
  name: string;
  size?: number;
  round?: boolean;
  className?: string;
}) {
  const url = usePortraits((s) => (id ? s.urls[id] : null));
  const load = usePortraits((s) => s.load);
  useEffect(() => {
    if (id) void load(id);
  }, [id, load]);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <div
      className={cx(
        "flex flex-none items-center justify-center overflow-hidden border border-edge-strong bg-card-3 font-display text-ink",
        round ? "rounded-full" : "rounded",
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.34 }}
      aria-hidden="true"
    >
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : initials || "?"}
    </div>
  );
}

/** kenli F-011 §3.5: why a portrait wasn't changed, in the app's words (the old one stays). */
export function portraitProblemText(code: string): string {
  const key = `portrait.problem.${code}` as keyof typeof en;
  return Object.hasOwn(en, key) ? t(key) : t("portrait.problem.other", { code });
}

export function PortraitPicker({ id, name }: { id: string; name: string }) {
  const input = useRef<HTMLInputElement>(null);
  const setPortrait = usePortraits((s) => s.set);
  const remove = usePortraits((s) => s.remove);
  const has = usePortraits((s) => Boolean(s.urls[id]));
  const [problem, setProblem] = useState<string | null>(null);
  const show = (r: PortraitResult) => setProblem(r.ok ? null : portraitProblemText(r.code));
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Portrait id={id} name={name} size={96} />
      <div className="flex gap-1">
        <Button
          size="sm"
          icon="portrait"
          iconOnly
          label={t("sheet.setPortrait")}
          onClick={() => input.current?.click()}
        />
        {has && (
          <Button
            size="sm"
            icon="x"
            iconOnly
            label={t("sheet.removePortrait")}
            onClick={() => void remove(id).then(show)}
          />
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept={PORTRAIT_MIMES.join(",")}
        hidden
        aria-label={t("sheet.setPortrait")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void setPortrait(id, file).then(show);
          e.target.value = "";
        }}
      />
      {problem && (
        <p
          className="max-w-48 text-center text-sm text-red"
          role="alert"
          data-testid="portrait-problem"
        >
          {problem}
        </p>
      )}
    </div>
  );
}
