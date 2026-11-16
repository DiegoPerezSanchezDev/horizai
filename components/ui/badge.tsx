import type { HTMLAttributes } from "react";

import { cn } from "./utils";

export type BadgeVariant = "neutral" | "accent" | "success" | "warning" | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantClasses: Record<BadgeVariant, string> = {
  neutral: "border-hairline-strong bg-surface/60 text-muted-foreground",
  accent: "border-accent/25 bg-accent-soft text-accent",
  success: "border-success/25 bg-success-soft text-success",
  warning: "border-warning/25 bg-warning-soft text-warning",
  danger: "border-danger/25 bg-danger-soft text-danger",
};

export function Badge({ className, variant = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-medium leading-none transition-colors duration-200",
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  );
}
