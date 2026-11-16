import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "./utils";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("glass-panel p-6 transition-colors duration-200", className)}
      {...props}
    />
  ),
);

Card.displayName = "Card";

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-5 space-y-1.5", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("space-y-4", className)} {...props} />;
}
