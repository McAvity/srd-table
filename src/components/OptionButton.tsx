/**
 * An option the engine lists, available or not. An unavailable one is never hidden: it stays in
 * place, with a dashed outline and still focusable (`aria-disabled`), with the engine's reason word
 * for word under the label (on a quick-bar tile too, where hover also shows it whole), and always
 * read by screen readers (`aria-describedby`). The GM's view may still open an unavailable one
 * (`onUnavailable`), to override the refusal.
 */

import { Tooltip } from "radix-ui";
import { type ReactNode, useId } from "react";
import { Icon, type IconName } from "./Icon";
import { cx } from "./ui";

export function OptionButton({
  children,
  reason,
  onClick,
  onUnavailable,
  icon,
  on,
  detail,
  className,
  variant = "row",
}: {
  children: ReactNode;
  /** Why it can't be chosen (the engine's words); `null` when it can. */
  reason: string | null;
  onClick?: () => void;
  /** Clicked while unavailable (the GM's "Do it anyway"); otherwise nothing happens. */
  onUnavailable?: () => void;
  icon?: IconName;
  on?: boolean;
  /** A second line (a cost, uses left). */
  detail?: ReactNode;
  className?: string;
  /** `row`: a full-width list entry; `tile`: a quick-bar card that grows with its text. */
  variant?: "row" | "tile";
}) {
  const reasonId = useId();
  const unavailable = reason !== null;
  const button = (
    <button
      type="button"
      aria-disabled={unavailable || undefined}
      aria-describedby={unavailable ? reasonId : undefined}
      aria-pressed={on === undefined ? undefined : on}
      data-on={on ? "true" : undefined}
      onClick={() => {
        if (!unavailable) onClick?.();
        else onUnavailable?.();
      }}
      className={cx(
        "btn",
        variant === "row"
          ? "w-full !justify-start text-left"
          : "min-w-[9rem] max-w-[15rem] !items-start !justify-start !gap-2 !py-2 !pr-7 !pl-2.5 text-left leading-snug",
        className,
      )}
    >
      {icon && (
        <Icon name={icon} size={18} className={cx("flex-none", variant === "tile" && "mt-0.5")} />
      )}
      <span className={cx("min-w-0", variant === "row" && "flex-1")}>
        <span className="block">{children}</span>
        {detail && (
          <span
            className={cx(
              "block text-[13px] font-normal text-ink-muted",
              variant === "tile" && "line-clamp-2",
            )}
          >
            {detail}
          </span>
        )}
        {unavailable && (
          <span
            id={reasonId}
            className={cx(
              "block text-[13px] font-normal text-ink-muted italic",
              variant === "tile" && "line-clamp-2",
            )}
          >
            {reason}
          </span>
        )}
      </span>
    </button>
  );
  if (variant === "row" || (!unavailable && !detail)) return button;
  return (
    <Tooltip.Root delayDuration={250}>
      <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          sideOffset={6}
          className="z-50 max-w-xs rounded-md border border-edge-strong bg-card-2 px-3 py-2 text-sm shadow-panel"
        >
          <div className="font-semibold">{children}</div>
          {detail && <div className="text-ink-muted">{detail}</div>}
          {unavailable && (
            <div className="flex gap-1.5 text-ink">
              <Icon name="lock" size={15} className="mt-0.5 flex-none text-red" />
              {reason}
            </div>
          )}
          <Tooltip.Arrow className="fill-edge-strong" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
