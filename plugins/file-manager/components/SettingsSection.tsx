// components/SettingsSection.tsx — the `app.slots.settingsSection` body on the
// plugin's detail page in Tools.
//
// It exists because bb's declarative settings form can only render the four
// descriptor types (string / select / boolean / project) and none of them is a
// path picker: `startFolder` therefore shows up above this section as a bare
// text field. This section is the same setting with a folder browser attached —
// it writes through the very same `savePreferences` method the panel uses
// (lib/start-folder.ts), so the CLI, the panel action and this form can never
// disagree.
//
// The host draws the heading and the one-line description from the registration
// in app.tsx (apps/app/src/components/plugin/PluginSettingsSections.tsx), so
// this component starts straight at the value — no heading of its own.
//
// Slot props are deliberately empty in V1, and the host mounts this outside the
// panel's subtree, so everything it renders comes from `getState`.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSettings, type PluginSettingsSectionProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { errorToastText } from "../lib/errors";
import { isSamePath } from "../lib/fm-paths";
import { useFmRpc, type RpcOutput } from "../lib/fm-rpc";
import { forgetLastFolder, readLastFolder } from "../lib/last-folder";
import {
  isExternalBooleanSettingChange,
  isExternalSettingChange,
  saveStartFolder,
  startFolderLabel,
  startFolderNotInUse,
  START_FOLDER_SAVED_TEXT,
  START_FOLDER_SAVE_FAILED_TEXT,
} from "../lib/start-folder";
import { FolderPickerDialog } from "./dialogs/FolderPickerDialog";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

type PanelState = RpcOutput<"getState">;

export function SettingsSection(_props: PluginSettingsSectionProps) {
  const rpc = useFmRpc();
  /**
   * A change signal, never something to render.
   *
   * `startFolder` has three other writers — the text field above this section,
   * the panel's "Set as start folder" action and `bb plugin config` — and every
   * effective change makes the server broadcast `plugins-changed`
   * (apps/server/src/services/plugins/plugin-service.ts#updateSettings), which
   * the app turns into an invalidation of this very query
   * (hooks/cache-owners/realtime-cache-registry.ts → dirtyPluginManagementQueries
   * → allPluginSettingsQueryKeyPrefix). A *new* value here therefore means our
   * `getState` snapshot is stale and has to be read again.
   *
   * The value itself stays off the screen: it is a cache that can lag behind
   * both the filesystem and the backend by a refetch, so it is never rendered
   * as *the* start folder. It is compared against `getState` for one thing
   * only — `startFolderNotInUse`, the single disagreement that can only mean
   * the backend fell back — and only while `state` is a read rather than a
   * value this section patched in from its own save. 0.3.0 compared them
   * without either guard and produced confident nonsense ("the saved path
   * could not be opened" about a path that was fine).
   */
  const hostSettings = useSettings().values;
  const rawStartFolder = hostSettings?.startFolder;
  /**
   * The second key with the same job. `restoreLastFolder` decides *which* of
   * the two folders below is the one that opens, so a change to it makes the
   * copy in this section wrong until it is re-read.
   */
  const rawRestoreLastFolder = hostSettings?.restoreLastFolder;
  /**
   * The third: with `openThreadWorkspace` on, a thread's tab skips both folders
   * and the copy below says so — which it can only do after a re-read.
   */
  const rawOpenThreadWorkspace = hostSettings?.openThreadWorkspace;

  const [state, setState] = useState<PanelState | null>(null);
  /**
   * True while `state` is a `getState` answer rather than a value patched in
   * from this section's own save. Only a read may be compared with the host's
   * cached setting: right after a save that cache still holds the previous
   * value. Our write makes the server broadcast `plugins-changed`, the host
   * refetches, and the re-read that follows puts this back to true.
   */
  const [stateIsRead, setStateIsRead] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * Where the browser opens, captured when Browse is pressed rather than read
   * live: a background refresh landing while it is open must not yank the user
   * back out of the folder they are inspecting.
   */
  const [pickerStart, setPickerStart] = useState<string | null>(null);
  /**
   * Whether a remembered folder exists right now. Client-side and free to
   * read: `lib/last-folder.ts` is module scope in the same bundle, exactly
   * like `components/panel-bus.ts`, so this section can answer for the panel's
   * memory without an RPC even though the host mounts it elsewhere.
   */
  const [hasMemory, setHasMemory] = useState(() => readLastFolder() !== null);

  // Mounted-guard: a settings page can be navigated away from mid-request, and
  // a setState on an unmounted section is a console warning nobody can act on.
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  /**
   * Refreshes fire on their own schedule (a broadcast, a window focus), so one
   * can still be in flight when a save starts — and `savePreferences` answers
   * with something strictly newer than a `getState` issued before it. Loads
   * therefore carry both a sequence number (two refreshes racing) and the save
   * generation they were issued under (a refresh overtaken by a save).
   */
  const loadSeqRef = useRef(0);
  const saveGenRef = useRef(0);
  const savingRef = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeqRef.current;
    const generation = saveGenRef.current;
    const superseded = (): boolean =>
      !activeRef.current || loadSeqRef.current !== seq || saveGenRef.current !== generation;
    try {
      const result = await rpc.call("getState", null);
      if (superseded()) return;
      setState(result);
      setStateIsRead(true);
      setHasMemory(readLastFolder() !== null);
      setLoadError(null);
    } catch (failure) {
      if (superseded()) return;
      setLoadError(errorToastText(failure, "Could not read the File Manager settings."));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  /** A re-read that yields to a save in progress — that save knows better. */
  const refresh = useCallback((): void => {
    if (savingRef.current) return;
    void load();
  }, [load]);

  // Someone else wrote the setting (the form above, the panel, the CLI, another
  // window): the host has already refetched its copy, so re-read the state the
  // section shows. The first delivery is the query resolving, not a change.
  const lastRawRef = useRef<string | number | boolean | undefined>(undefined);
  useEffect(() => {
    const previous = lastRawRef.current;
    lastRawRef.current = rawStartFolder;
    if (isExternalSettingChange(previous, rawStartFolder)) refresh();
  }, [rawStartFolder, refresh]);

  const lastRawRestoreRef = useRef<string | number | boolean | undefined>(undefined);
  useEffect(() => {
    const previous = lastRawRestoreRef.current;
    lastRawRestoreRef.current = rawRestoreLastFolder;
    if (isExternalBooleanSettingChange(previous, rawRestoreLastFolder)) refresh();
  }, [rawRestoreLastFolder, refresh]);

  const lastRawThreadFolderRef = useRef<string | number | boolean | undefined>(undefined);
  useEffect(() => {
    const previous = lastRawThreadFolderRef.current;
    lastRawThreadFolderRef.current = rawOpenThreadWorkspace;
    if (isExternalBooleanSettingChange(previous, rawOpenThreadWorkspace)) refresh();
  }, [rawOpenThreadWorkspace, refresh]);

  // Coming back to the page refreshes too: a broadcast can be missed while the
  // socket is down, and a start folder can stop existing (deleted, renamed)
  // without any setting changing at all.
  useEffect(() => {
    const onForeground = (): void => {
      if (document.visibilityState === "hidden") return;
      refresh();
    };
    window.addEventListener("focus", onForeground);
    document.addEventListener("visibilitychange", onForeground);
    return () => {
      window.removeEventListener("focus", onForeground);
      document.removeEventListener("visibilitychange", onForeground);
    };
  }, [refresh]);

  // The root is the home directory of whoever runs bb, so only the backend
  // knows it: `getClientRoot()` is still "/" until the *panel* mounts, and this
  // section can be the first thing rendered in a fresh app. Everything that
  // needs it therefore stays null until `getState` answers — the actions are
  // disabled for exactly as long.
  const root = state?.root ?? null;
  const startFolder = state?.startFolder ?? null;
  const atRoot = state !== null && isSamePath(state.startFolder, state.root);
  /**
   * Having a snapshot is the whole requirement. A *background* re-read that
   * failed says nothing about the snapshot already in hand — the folder
   * browser and Reset work off `state`, and disabling them would answer a
   * failed refresh by removing the user's way out of it. The failure is
   * reported next to the value instead, with its own retry.
   */
  const ready = state !== null;

  /**
   * "Your start folder is not the one being used" — the only honest signal
   * available here, and only from a snapshot that was read rather than
   * patched. See `startFolderNotInUse` for why it is this narrow.
   */
  const notInUse =
    state === null || !stateIsRead
      ? null
      : startFolderNotInUse(rawStartFolder, state.startFolder, state.root);

  const choose = useCallback(
    (path: string): void => {
      setSaveError(null);
      setSaving(true);
      savingRef.current = true;
      const generation = ++saveGenRef.current;
      void (async () => {
        try {
          const resolved = await saveStartFolder(rpc, path);
          if (!activeRef.current || saveGenRef.current !== generation) return;
          // The backend realpaths and re-validates; render its answer, and keep
          // the rest of the cached state so nothing else flickers.
          setState((previous) =>
            previous === null ? previous : { ...previous, startFolder: resolved },
          );
          setStateIsRead(false);
          // A round-trip just succeeded, so "could not read the settings" is
          // over: the only field this backend can change at runtime is the one
          // the answer carries. Leaving it up would hide the save behind a
          // stale failure and keep a retry on screen for nothing.
          setLoadError(null);
          toast.success(START_FOLDER_SAVED_TEXT);
        } catch (failure) {
          if (!activeRef.current || saveGenRef.current !== generation) return;
          setSaveError(errorToastText(failure, START_FOLDER_SAVE_FAILED_TEXT));
        } finally {
          if (saveGenRef.current === generation) {
            savingRef.current = false;
            if (activeRef.current) setSaving(false);
          }
        }
      })();
    },
    [rpc],
  );

  return (
    <div className="w-full space-y-2" data-testid="fm-settings-section">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
          <Icon
            name="Folder"
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          {state === null || startFolder === null ? (
            <span className="text-sm text-muted-foreground">
              {loadError === null ? "Loading…" : "Unavailable"}
            </span>
          ) : (
            <>
              <span
                className="min-w-0 flex-1 truncate font-mono text-sm text-foreground"
                title={startFolder}
                data-testid="fm-settings-start-folder"
              >
                {startFolder}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {startFolderLabel(state.startFolder, state.root)}
              </span>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Deliberately still enabled while a save runs: Radix hands focus
              back to whatever opened the dialog, and focus() on a disabled
              button is a no-op that drops it on <body>. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!ready}
            data-testid="fm-settings-browse"
            onClick={() => {
              if (state === null) return;
              setSaveError(null);
              setPickerStart(state.startFolder);
              setPickerOpen(true);
            }}
          >
            <Icon name="FolderOpen" className="size-4" aria-hidden="true" />
            Browse…
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!ready || saving || atRoot}
            data-testid="fm-settings-reset"
            onClick={() => {
              if (state !== null) choose(state.root);
            }}
          >
            {root === null ? "Reset" : `Reset to ${root}`}
          </Button>
          {/* Pure client-side: no RPC, no settings write. The memory is a
              trace in this browser profile, not a stored decision (§1.9). */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!ready || !hasMemory}
            data-testid="fm-settings-forget"
            onClick={() => {
              if (state === null) return;
              forgetLastFolder();
              setHasMemory(false);
              toast.success(
                `Forgotten. The panel will open in ${startFolderLabel(
                  state.startFolder,
                  state.root,
                )} next time.`,
              );
            }}
          >
            Forget the remembered folder
          </Button>
        </div>
      </div>

      <div className="flex min-h-5 items-start justify-between gap-4">
        {/* The one thing the host's own checkbox cannot say: which of the two
            folders is actually in effect. "The panel opens here every time" is
            only true with the toggle off, so it is now a pair (§2.2). */}
        <p
          className="text-xs leading-relaxed text-muted-foreground"
          data-testid="fm-settings-open-rule"
        >
          {state === null
            ? "The panel opens here."
            : state.preferences.restoreLastFolder
              ? "Reopening the last folder is on, so this is where the panel opens the first time and whenever the last folder is gone."
              : "Reopening the last folder is off, so the panel always opens here."}
          {/* The thread-folder toggle outranks both of the rules above, but
              only on a thread's panel tab — saying so here is the only place
              the two settings are seen together. */}
          {state !== null && state.preferences.openThreadWorkspace
            ? " Opening the thread's project folder is on, so a File Manager tab inside a thread starts in that thread's folder instead."
            : null}
          {root === null ? null : ` Everything stays inside ${root}.`}
        </p>
        <div className="flex shrink-0 items-center gap-3">
          {loadError !== null ? (
            <>
              <span className="text-xs text-destructive" role="alert">
                {loadError}
              </span>
              {/* `refresh`, never `load` directly: a getState issued while a
                  save is in flight answers with the pre-save value and would
                  land after it. The save is about to say what the setting is,
                  and the host's broadcast re-reads right behind it. */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="fm-settings-retry"
                onClick={() => refresh()}
              >
                Try again
              </Button>
            </>
          ) : saveError !== null ? (
            <span className="text-xs text-destructive" role="alert">
              {saveError}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground" role="status">
              {saving ? "Saving…" : state === null ? "Loading…" : "Saved"}
            </span>
          )}
        </div>
      </div>

      {/* Not a live region: the two the section already has (the save status
          and the error) are about something the user just did, while this is
          standing copy about the stored value — a third one competing for the
          same announcement is noise. */}
      {notInUse === null || root === null ? null : (
        <p className="text-xs leading-relaxed text-warning-text" data-testid="fm-settings-fallback">
          The saved start folder <span className="font-mono">{notInUse}</span> is not in use: the
          panel opens {root}.
        </p>
      )}

      {/* The same browser the panel opens for "Move to…" / "Copy to…" (§8.6):
          one picker, one listDir path, no second implementation.

          Mounted only once Browse has been pressed. The picker seeds its `path`
          from `initialPath` on first render and re-seeds it on open, so a picker
          mounted while the root is still unknown would list "/" — one wasted
          listDir that the backend answers with `path_escape`. It stays mounted
          after closing so Radix can play the exit animation and hand focus
          back. */}
      {pickerStart === null || state === null ? null : (
        <FolderPickerDialog
          open={pickerOpen}
          title="Start folder"
          description="The panel will open in the folder you choose here."
          initialPath={pickerStart}
          root={state.root}
          showHidden={state.preferences.showHiddenFiles}
          confirmLabel="Use this folder"
          onOpenChange={setPickerOpen}
          onChoose={choose}
        />
      )}
    </div>
  );
}
