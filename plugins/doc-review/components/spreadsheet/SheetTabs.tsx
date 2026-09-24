// Sheet tabs along the bottom, as in Excel: visible sheets are tabs, hidden
// ones sit behind a small menu and still open from there.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type WheelEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { SheetSummary } from "@/lib/sheet-model";

interface IndexedSheet extends SheetSummary {
  index: number;
}

export function tabId(panelId: string, index: number): string {
  return `${panelId}-tab-${index}`;
}

function HiddenSheetsMenu({
  sheets,
  selected,
  onSelect,
}: {
  sheets: IndexedSheet[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const current = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(current + step + items.length) % items.length]?.focus();
  };

  return (
    <div ref={rootRef} className="relative flex shrink-0 items-center px-1">
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-2 text-xs font-normal text-muted-foreground [&_svg]:size-3.5"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="EyeOff" aria-hidden />
        {sheets.length} hidden
      </Button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Hidden sheets"
          className="absolute bottom-full left-1 z-50 mb-1 max-h-64 min-w-48 max-w-72 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          onKeyDown={onMenuKeyDown}
        >
          <p className="px-2 pb-1 pt-0.5 text-xs text-muted-foreground">
            Hidden sheets
          </p>
          {sheets.map((sheet) => (
            <button
              key={sheet.index}
              type="button"
              role="menuitem"
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-state-hover focus-visible:bg-state-hover"
              onClick={() => {
                onSelect(sheet.index);
                close();
              }}
            >
              <span className="min-w-0 flex-1 truncate">{sheet.name}</span>
              {sheet.index === selected ? (
                <Icon
                  name="Check"
                  className="size-3.5 shrink-0"
                  aria-label="Open"
                />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SheetTabs({
  sheets,
  selected,
  loading,
  panelId,
  onSelect,
}: {
  sheets: SheetSummary[];
  selected: number;
  loading: number | null;
  panelId: string;
  onSelect: (index: number) => void;
}) {
  const indexed = sheets.map((sheet, index) => ({ ...sheet, index }));
  // A hidden sheet opened from the menu shows as a tab while it is open.
  const tabs = indexed.filter(
    (sheet) => !sheet.hidden || sheet.index === selected,
  );
  const hidden = indexed.filter((sheet) => sheet.hidden);

  const stripRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const updateOverflow = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const left = strip.scrollLeft > 1;
    const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
    setOverflow((current) =>
      current.left === left && current.right === right
        ? current
        : { left, right },
    );
  }, []);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [updateOverflow, tabs.length]);

  // Keep the selected tab in view.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const tab = strip?.querySelector<HTMLElement>(`[data-sheet="${selected}"]`);
    if (!strip || !tab) return;
    if (tab.offsetLeft < strip.scrollLeft) {
      strip.scrollLeft = tab.offsetLeft;
    } else if (
      tab.offsetLeft + tab.offsetWidth >
      strip.scrollLeft + strip.clientWidth
    ) {
      strip.scrollLeft = tab.offsetLeft + tab.offsetWidth - strip.clientWidth;
    }
  }, [selected]);

  const scrollBy = (direction: 1 | -1) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.scrollBy({
      left: direction * strip.clientWidth * 0.7,
      behavior: "smooth",
    });
  };

  // A mouse wheel scrolls the tabs sideways.
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const strip = stripRef.current;
    if (!strip || event.deltaX !== 0 || event.deltaY === 0) return;
    strip.scrollLeft += event.deltaY;
  };

  // Arrow keys move between tabs; Enter or Space opens one, since opening
  // may load the sheet.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const buttons = Array.from(
      stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
    );
    const current = buttons.indexOf(document.activeElement as HTMLElement);
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else next = current + (event.key === "ArrowRight" ? 1 : -1);
    const target = buttons[Math.max(0, Math.min(buttons.length - 1, next))];
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  const scrollButton =
    "h-full w-6 shrink-0 rounded-none px-0 text-muted-foreground [&_svg]:size-3.5";

  return (
    <div className="flex min-w-0 flex-1 items-stretch">
      {overflow.left ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={scrollButton}
          onClick={() => scrollBy(-1)}
          aria-label="Scroll sheet tabs left"
          tabIndex={-1}
        >
          <Icon name="ChevronLeft" aria-hidden />
        </Button>
      ) : null}
      <div
        ref={stripRef}
        role="tablist"
        aria-label="Sheets"
        className="flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={updateOverflow}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
      >
        {tabs.map((sheet) => {
          const isSelected = sheet.index === selected;
          return (
            <button
              key={sheet.index}
              id={tabId(panelId, sheet.index)}
              type="button"
              role="tab"
              data-sheet={sheet.index}
              aria-selected={isSelected}
              aria-controls={panelId}
              tabIndex={isSelected ? 0 : -1}
              title={sheet.hidden ? `${sheet.name} (hidden sheet)` : sheet.name}
              className={cn(
                "relative flex max-w-52 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-r border-border px-3 text-xs outline-none focus-visible:bg-state-hover",
                isSelected
                  ? "bg-background font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground"
                  : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
              )}
              onClick={() => {
                if (!isSelected) onSelect(sheet.index);
              }}
            >
              {sheet.hidden ? (
                <Icon name="EyeOff" className="size-3.5 shrink-0" aria-hidden />
              ) : sheet.kind === "chartsheet" ? (
                <Icon
                  name="ChartColumn"
                  className="size-3.5 shrink-0"
                  aria-hidden
                />
              ) : null}
              <span className="truncate">{sheet.name}</span>
              {loading === sheet.index ? (
                <Icon
                  name="Loading"
                  className="size-3 shrink-0 animate-spin"
                  aria-label="Loading"
                />
              ) : null}
            </button>
          );
        })}
      </div>
      {overflow.right ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={scrollButton}
          onClick={() => scrollBy(1)}
          aria-label="Scroll sheet tabs right"
          tabIndex={-1}
        >
          <Icon name="ChevronRight" aria-hidden />
        </Button>
      ) : null}
      {hidden.length > 0 ? (
        <HiddenSheetsMenu
          sheets={hidden}
          selected={selected}
          onSelect={onSelect}
        />
      ) : null}
    </div>
  );
}
