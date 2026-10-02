import * as React from "react";
import { cn } from "@/lib/utils/cn";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
