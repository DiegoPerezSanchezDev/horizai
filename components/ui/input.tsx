import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "./utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-11 w-full rounded-tile border border-hairline-strong bg-surface/70 px-3 text-sm text-foreground outline-none transition-colors duration-200 placeholder:text-faint hover:border-border-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-45 aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:ring-danger/20",
        className,
      )}
      {...props}
    />
  ),
);

Input.displayName = "Input";
