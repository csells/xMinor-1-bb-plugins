// A workbook in the viewer: the selected sheet's grid, Excel-style sheet
// tabs along the bottom, zoom, and notices for cut, empty or failed sheets.
// The container fetches sheets; this view only shows what it is given.
import { useCallback, useId, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  SHEET_CELL_LIMIT,
  type SheetData,
  type WorkbookSummary,
} from "@/lib/sheet-model";
import { stepZoom } from "@/lib/sheet-layout";
import { GRID_CSS } from "./paper";
import { SheetGrid, layoutFor } from "./SheetGrid";
import { SheetTabs, tabId } from "./SheetTabs";
import { ZoomControl } from "./ZoomControl";

export interface SpreadsheetViewProps {
  workbook: WorkbookSummary;
  /** The tab the user picked; it may still be loading. */
  selectedSheet: number;
  /**
   * The sheet to show: the selected one, or the previous one while the
   * selected one loads. Null while the selected sheet loads the first time.
   */
  sheet: SheetData | null;
  /** Index being fetched, for tab feedback; null when idle. */
  loadingSheet: number | null;
  /** Failure to load the selected sheet. */
  error: string | null;
  onSelectSheet: (index: number) => void;
}

const numberFormat = new Intl.NumberFormat("en-US");

function truncationNotice(sheet: SheetData): string {
  const rows = sheet.rowCount < sheet.totalRows;
  const cols = sheet.colCount < sheet.totalCols;
  const shownRows = numberFormat.format(sheet.rowCount);
  const allRows = numberFormat.format(sheet.totalRows);
  const shownCols = numberFormat.format(sheet.colCount);
  const allCols = numberFormat.format(sheet.totalCols);
  if (rows && cols) {
    return `Showing the first ${shownRows} of ${allRows} rows and ${shownCols} of ${allCols} columns.`;
  }
  if (rows) return `Showing the first ${shownRows} of ${allRows} rows.`;
  if (cols) return `Showing the first ${shownCols} of ${allCols} columns.`;
  return `Some cells are not shown: the viewer reads up to ${numberFormat.format(
    SHEET_CELL_LIMIT,
  )} cells per sheet.`;
}

function StatusMessage({
  icon,
  title,
  detail,
  tone = "muted",
}: {
  icon: IconName;
  title: string;
  detail?: string;
  tone?: "muted" | "destructive";
}) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-center">
      <div className="flex max-w-md flex-col items-center gap-2">
        <Icon
          name={icon}
          className={cn(
            "size-6",
            tone === "destructive"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
          aria-hidden
        />
        <p
          className={cn(
            "text-sm font-medium",
            tone === "destructive" && "text-destructive",
          )}
        >
          {title}
        </p>
        {detail ? (
          <p className="break-words text-sm text-muted-foreground">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}

function LoadingMessage({ label }: { label: string }) {
  return (
    <div
      className="flex h-full w-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
      role="status"
    >
      <Icon name="Loading" className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function SpreadsheetView({
  workbook,
  selectedSheet,
  sheet,
  loadingSheet,
  error,
  onSelectSheet,
}: SpreadsheetViewProps) {
  const [zoom, setZoom] = useState(1);
  const panelId = useId();
  const onZoomStep = useCallback(
    (direction: 1 | -1) => setZoom((current) => stepZoom(current, direction)),
    [],
  );

  const selected = workbook.sheets[selectedSheet];
  const selectedName = selected?.name ?? "sheet";
  const stale = sheet !== null && sheet.index !== selectedSheet;
  const shownSummary = sheet ? workbook.sheets[sheet.index] : undefined;
  const layout = sheet ? layoutFor(sheet) : null;

  let body: ReactNode;
  let showsGrid = false;
  // The previous sheet stays on screen, dimmed, while the selected one loads.
  let dimmed = false;
  if (selected && selected.kind !== "worksheet") {
    // Nothing to fetch for these: say so at once, whatever the container does.
    body =
      selected.kind === "chartsheet" ? (
        <StatusMessage
          icon="ChartColumn"
          title={`“${selected.name}” is a chart sheet`}
          detail="Charts are not shown in this viewer. Download the file to see it."
        />
      ) : (
        <StatusMessage
          icon="FileQuestion"
          title={`“${selected.name}” can't be shown`}
          detail="It is a macro or dialog sheet, not a worksheet with cells."
        />
      );
  } else if (error) {
    body = (
      <StatusMessage
        icon="AlertTriangle"
        tone="destructive"
        title={`Could not load “${selectedName}”`}
        detail={error}
      />
    );
  } else if (
    !sheet ||
    !layout ||
    (stale && shownSummary?.kind !== "worksheet")
  ) {
    body = <LoadingMessage label={`Loading “${selectedName}”…`} />;
  } else if (layout.rows.length === 0 || layout.cols.length === 0) {
    dimmed = stale;
    body = (
      <StatusMessage
        icon="Sheet"
        title={
          sheet.rowCount === 0 || sheet.colCount === 0
            ? "This sheet is empty"
            : "Every row or column of this sheet is hidden"
        }
      />
    );
  } else {
    dimmed = stale;
    showsGrid = true;
    // Keyed by the sheet object: a new sheet starts a fresh grid at the top.
    body = (
      <SheetGrid
        key={gridKey(sheet)}
        sheet={sheet}
        zoom={zoom}
        onZoomStep={onZoomStep}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <style>{GRID_CSS}</style>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={selected ? tabId(panelId, selectedSheet) : undefined}
        aria-busy={loadingSheet !== null}
        className="relative min-h-0 flex-1"
      >
        <div
          className={cn(
            "absolute inset-0 transition-opacity duration-150",
            dimmed && "pointer-events-none opacity-50",
          )}
        >
          {body}
        </div>
        {dimmed ? (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center">
            <div
              role="status"
              className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-sm"
            >
              <Icon
                name="Loading"
                className="size-3.5 animate-spin"
                aria-hidden
              />
              Loading “{selectedName}”…
            </div>
          </div>
        ) : null}
      </div>
      {sheet && !stale && sheet.truncated && showsGrid ? (
        <div
          role="note"
          className="flex h-6 shrink-0 items-center gap-1.5 border-t border-border bg-muted/40 px-2 text-xs text-muted-foreground"
        >
          <Icon name="Info" className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate" title={truncationNotice(sheet)}>
            {truncationNotice(sheet)}
          </span>
        </div>
      ) : null}
      <div className="relative flex h-8 shrink-0 items-stretch border-t border-border bg-muted/40">
        <SheetTabs
          sheets={workbook.sheets}
          selected={selectedSheet}
          loading={loadingSheet}
          panelId={panelId}
          onSelect={onSelectSheet}
        />
        <ZoomControl zoom={zoom} onZoom={setZoom} disabled={!showsGrid} />
      </div>
    </div>
  );
}

const gridKeys = new WeakMap<SheetData, number>();
let nextGridKey = 0;

/** A stable key per sheet object, so reloading the same sheet remounts its grid too. */
function gridKey(sheet: SheetData): number {
  let key = gridKeys.get(sheet);
  if (key === undefined) {
    key = nextGridKey += 1;
    gridKeys.set(sheet, key);
  }
  return key;
}
