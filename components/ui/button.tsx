import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "./utils";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: "btn-primary-glow",
  secondary: "btn-outline-glass",
  ghost:
    "text-muted-foreground hover:bg-accent-soft hover:text-foreground-strong",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-9 rounded-pill px-3.5 text-[0.8rem]",
  md: "h-10 rounded-pill px-4 text-sm",
  lg: "h-12 rounded-pill px-6 text-[0.95rem]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "primary",
      size = "md",
      type = "button",
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 font-medium tracking-[-0.005em] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  ),
);

Button.displayName = "Button";
