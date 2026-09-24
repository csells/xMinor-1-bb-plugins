import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";

/** A centered block for loading, empty and error states. */
export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      <div className="max-w-md space-y-3">{children}</div>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3" role="status">
      <Icon name="Loading" className="size-5 animate-spin" aria-hidden />
      <p>{label}</p>
    </div>
  );
}
