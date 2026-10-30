/**
 * Shared building blocks, in the table's look (Mat and Marker): buttons by weight, section titles,
 * dialogs, tabs, tick boxes for slots and uses, HP bars. Radix provides the accessible behavior.
 */

import { Dialog as RDialog, Tabs as RTabs } from "radix-ui";
import { type ButtonHTMLAttributes, forwardRef, type ReactNode, useId } from "react";
import { t } from "@/i18n";
import { Icon, type IconName } from "./Icon";

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: IconName;
  variant?: "normal" | "primary" | "danger" | "ghost";
  size?: "md" | "sm";
  /** Lit: the chosen tab, an option that's on. */
  on?: boolean;
  /** Only the icon shows; `label` is the accessible name. */
  iconOnly?: boolean;
  label?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    icon,
    variant = "normal",
    size = "md",
    on,
    iconOnly,
    label,
    className,
    children,
    type,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      data-on={on ? "true" : undefined}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : rest.title}
      className={cx(
        variant === "ghost"
          ? "inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-ink-muted hover:text-ink"
          : "btn",
        variant === "primary" && "btn-primary",
        variant === "danger" && "btn-danger",
        size === "sm" && variant !== "ghost" && "btn-sm",
        iconOnly && variant !== "ghost" && "!px-2",
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 16 : 18} />}
      {iconOnly ? null : (children ?? label)}
    </button>
  );
});

/** An index card with a bold title. */
export function Section({
  title,
  actions,
  children,
  className,
  bodyClassName,
  id,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cx("panel p-3", className)} id={id}>
      <div className="mb-2 flex items-center gap-2">
        <h2 id={headingId} className="section-title min-w-0 flex-1">
          {title}
        </h2>
        {actions}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-4">
      <h1 className="font-display text-3xl font-semibold text-ink">{children}</h1>
      {sub && <p className="text-ink-muted">{sub}</p>}
    </div>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <RDialog.Content
          className={cx(
            "panel rise-in fixed top-1/2 left-1/2 z-50 max-h-[88vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 shadow-panel",
            wide ? "max-w-3xl" : "max-w-lg",
          )}
        >
          <div className="mb-3 flex items-start gap-3">
            <RDialog.Title className="flex-1 font-display text-2xl text-ink">{title}</RDialog.Title>
            <RDialog.Close asChild>
              <Button variant="ghost" icon="x" iconOnly label={t("common.close")} />
            </RDialog.Close>
          </div>
          {description ? (
            <RDialog.Description className="mb-3 text-ink-muted">{description}</RDialog.Description>
          ) : (
            <RDialog.Description className="sr-only">{title}</RDialog.Description>
          )}
          {children}
          {footer && <div className="mt-4 flex flex-wrap justify-end gap-2">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export interface TabItem<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  readonly icon?: IconName;
  readonly content: ReactNode;
}

export function Tabs<T extends string>({
  value,
  onValueChange,
  items,
  label,
  className,
}: {
  value: T;
  onValueChange: (value: T) => void;
  items: readonly TabItem<T>[];
  label: string;
  className?: string;
}) {
  return (
    <RTabs.Root
      value={value}
      onValueChange={(v) => onValueChange(v as T)}
      className={cx("flex min-h-0 flex-col", className)}
    >
      <RTabs.List aria-label={label} className="mb-3 flex flex-wrap gap-1.5">
        {items.map((item) => (
          <RTabs.Trigger
            key={item.value}
            value={item.value}
            className="btn btn-sm data-[state=active]:border-ink data-[state=active]:bg-hl data-[state=active]:text-hl-ink"
          >
            {item.icon && <Icon name={item.icon} size={16} />}
            {item.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {items.map((item) => (
        <RTabs.Content
          key={item.value}
          value={item.value}
          className="min-h-0 flex-1 focus-visible:outline-none"
        >
          {item.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  );
}

/** Spell slots or uses: one tick box per use, ticked through once spent. */
export function Gems({
  total,
  spent,
  label,
  onSpend,
  onRestore,
  spendWhenEmpty = false,
}: {
  total: number;
  spent: number;
  label: string;
  onSpend?: () => void;
  onRestore?: () => void;
  /**
   * kenli F-011 §5.3: spending is the player's attempt even with none left (the engine refuses it
   * and the refusal is journaled). Off for bookkeeping counters such as slot corrections.
   */
  spendWhenEmpty?: boolean;
}) {
  const left = Math.max(0, total - spent);
  const description = t("common.left", { left, total });
  const gems = Array.from({ length: total }, (_, i) => (
    <span key={i} className="tick inline-block" data-spent={i >= left ? "true" : "false"} />
  ));
  return (
    <div className="flex items-center gap-2">
      <span
        className="flex flex-wrap items-center gap-1.5"
        role="img"
        aria-label={`${label}: ${description}`}
      >
        {gems}
      </span>
      {(onSpend || onRestore) && (
        <span className="ml-auto flex gap-1">
          {onSpend && (
            <Button
              size="sm"
              icon="minus"
              iconOnly
              label={t("common.spendOne", { what: label })}
              onClick={onSpend}
              disabled={left === 0 && !spendWhenEmpty}
            />
          )}
          {onRestore && (
            <Button
              size="sm"
              icon="plus"
              iconOnly
              label={t("common.restoreOne", { what: label })}
              onClick={onRestore}
              disabled={spent === 0}
            />
          )}
        </span>
      )}
    </div>
  );
}

export function HpBar({
  hp,
  max,
  temp = 0,
  bloodied = false,
  className,
}: {
  hp: number;
  max: number;
  temp?: number;
  /** The engine's `bloodied`: the bar turns red. */
  bloodied?: boolean;
  className?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (hp / max) * 100)) : 0;
  return (
    <div
      className={cx(
        "relative h-1.5 overflow-hidden rounded-full border border-edge bg-card-2",
        className,
      )}
      aria-hidden="true"
    >
      <div
        className={cx("h-full rounded-full transition-[width]", bloodied ? "bg-red" : "bg-ink")}
        style={{ width: `${pct}%` }}
      />
      {temp > 0 && <div className="absolute inset-y-0 right-0 w-1/5 bg-blue/70" />}
    </div>
  );
}

/** Reasons the engine gave for refusing what the user just did, shown where they acted. */
export function Reasons({
  reasons,
  className,
}: {
  reasons: readonly string[] | null | undefined;
  className?: string;
}) {
  if (!reasons?.length) return null;
  return (
    <div
      role="alert"
      className={cx("rounded-md border border-red/60 bg-red-dim/40 px-3 py-2 text-sm", className)}
    >
      <ul className="space-y-0.5">
        {reasons.map((r) => (
          <li key={r} className="flex gap-2">
            <Icon name="warning" size={16} className="mt-0.5 flex-none text-red" />
            <span>{r}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Empty({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-ink-muted">
      {icon && <Icon name={icon} size={28} className="text-ink-muted" />}
      {children}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-ink-muted">
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-ink border-t-transparent" />
      <span>{label ?? t("common.loading")}</span>
    </div>
  );
}

/** A labelled number in a box: AC, HP, Speed… */
export function StatBox({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex min-w-[4.5rem] flex-col items-center rounded border border-edge bg-card px-2 py-1.5 shadow-card",
        className,
      )}
    >
      <span className="text-[13px] text-ink-muted">{label}</span>
      <span className="font-display text-2xl font-extrabold leading-tight text-ink">
        {children}
      </span>
    </div>
  );
}
