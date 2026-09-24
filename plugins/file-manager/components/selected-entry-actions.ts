// One selected-entry policy shared by every menu surface.
//
// Context menus and touch drawers paint differently, but action visibility,
// enablement, order and behavior must never diverge between them (§8.2).
import type { FileEntry } from "../contract";
import { isViewableEntry } from "../lib/viewer";
import { effectiveKind } from "./FileRow";
import type { IconName } from "./ui/icon";

export interface SelectedEntryActionsProps {
  /** Everything the action applies to; never empty when a surface renders. */
  entries: readonly FileEntry[];
  /** False when `listDir` said the current directory is read-only. */
  writable: boolean;
  canPaste: boolean;
  /** True when at least one extractor exists for the selected archive. */
  canExtract: boolean;
  /**
   * What `Enter` and a double-click do: walk into a folder, extract an
   * archive, show a file. One callback for all three because the menu should
   * not be the second place that decides which is which.
   */
  onOpen: (entry: FileEntry) => void;
  onDownload: () => void;
  /** One @-mention per selected file, into whatever composer is in reach (§8.8). */
  onAddToChat: () => void;
  onExtract: (entry: FileEntry) => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onMoveTo: () => void;
  onCopyTo: () => void;
  onRename: (entry: FileEntry) => void;
  onCopyPath: () => void;
  onDelete: () => void;
  onSetStartFolder: (entry: FileEntry) => void;
  onProperties: () => void;
  /** True when the single directory row is already bookmarked (§8.11). */
  bookmarked: boolean;
  /** False only while the list has not arrived yet. */
  canToggleBookmark: boolean;
  onToggleBookmark: (entry: FileEntry) => void;
}

export type SelectedEntryActionId =
  | "open"
  | "download"
  | "add-to-chat"
  | "extract"
  | "cut"
  | "copy"
  | "paste"
  | "move-to"
  | "copy-to"
  | "rename"
  | "copy-path"
  | "set-start-folder"
  | "bookmark"
  | "properties"
  | "delete";

export interface SelectedEntryAction {
  id: SelectedEntryActionId;
  label: string;
  icon: IconName;
  disabled: boolean;
  destructive?: boolean;
  /** Selection count displayed on every surface. */
  trailing?: string;
  /** Desktop-only keyboard hint. */
  shortcut?: string;
  run: () => void;
}

export interface SelectedEntryActionModel {
  label: string;
  groups: readonly (readonly SelectedEntryAction[])[];
}

export function selectedEntryActionModel(
  props: SelectedEntryActionsProps,
): SelectedEntryActionModel {
  const { entries, writable, canPaste, canExtract, bookmarked, canToggleBookmark } = props;
  const single = entries.length === 1 ? entries[0] : undefined;
  const directory = single !== undefined && effectiveKind(single) === "directory";
  const escapes = entries.some((entry) => entry.escapesRoot);
  // Both "Download" and "Add to chat" act on exactly the real files in the
  // selection: a folder has no bytes to send, and a link out of the root is
  // refused by the server anyway (§6).
  const files = entries.filter(
    (entry) => !entry.escapesRoot && effectiveKind(entry) === "file",
  );
  const archive = single !== undefined && single.archiveFormat !== null ? single : undefined;
  // Folders only, and one at a time: a bookmark or a start folder is a place
  // to go, and a file (or a selection of five) is not one.
  const folderAction = single !== undefined && directory && !escapes;
  // One row, one Open: a folder to walk into, an archive to extract, or a file
  // to read. Multiple rows have no single destination, and a link out of the
  // root has nothing this plugin is allowed to follow.
  const openable =
    single !== undefined && !escapes && (directory || isViewableEntry(single))
      ? single
      : undefined;

  const transfer: SelectedEntryAction[] = [];
  if (openable !== undefined) {
    transfer.push({
      id: "open",
      label: "Open",
      icon: directory ? "FolderOpen" : openable.archiveFormat !== null ? "ArchiveRestore" : "Eye",
      disabled: false,
      shortcut: "Enter",
      run: () => props.onOpen(openable),
    });
  }
  // "Add to chat" sits beside Download because it answers the same question —
  // "take this file somewhere" — with the other destination: the agent.
  transfer.push(
    {
      id: "download",
      label: "Download",
      icon: "Download",
      disabled: files.length === 0,
      trailing: entries.length > 1 ? String(entries.length) : undefined,
      run: props.onDownload,
    },
    {
      id: "add-to-chat",
      label: "Add to chat",
      icon: "MessageSquarePlus",
      disabled: files.length === 0,
      trailing: files.length > 1 ? String(files.length) : undefined,
      run: props.onAddToChat,
    },
  );
  if (archive !== undefined) {
    transfer.push({
      id: "extract",
      label: "Extract…",
      icon: "ArchiveRestore",
      disabled: !canExtract || !writable,
      run: () => props.onExtract(archive),
    });
  }

  const organize: SelectedEntryAction[] = [
    { id: "cut", label: "Cut", icon: "Layers", disabled: escapes, shortcut: "Ctrl+X", run: props.onCut },
    { id: "copy", label: "Copy", icon: "Copy", disabled: escapes, shortcut: "Ctrl+C", run: props.onCopy },
    {
      id: "paste",
      label: "Paste",
      icon: "PackageReceive",
      disabled: !canPaste || !writable,
      shortcut: "Ctrl+V",
      run: props.onPaste,
    },
  ];
  const destinations: SelectedEntryAction[] = [
    { id: "move-to", label: "Move to…", icon: "FolderExport", disabled: escapes, run: props.onMoveTo },
    { id: "copy-to", label: "Copy to…", icon: "Folder", disabled: escapes, run: props.onCopyTo },
  ];
  const details: SelectedEntryAction[] = [
    {
      id: "rename",
      label: "Rename",
      icon: "Edit",
      disabled: single === undefined || !writable,
      shortcut: "F2",
      run: () => {
        if (single !== undefined) props.onRename(single);
      },
    },
    { id: "copy-path", label: "Copy path", icon: "Paperclip", disabled: false, run: props.onCopyPath },
  ];
  if (folderAction) {
    details.push(
      {
        id: "set-start-folder",
        label: "Set as start folder",
        icon: "Pin",
        disabled: false,
        run: () => props.onSetStartFolder(single),
      },
      {
        id: "bookmark",
        label: bookmarked ? "Remove bookmark" : "Bookmark",
        icon: bookmarked ? "PinOff" : "Star",
        disabled: !canToggleBookmark,
        run: () => props.onToggleBookmark(single),
      },
    );
  }
  details.push({
    id: "properties",
    label: "Properties",
    icon: "Info",
    disabled: false,
    shortcut: "Alt+Enter",
    run: props.onProperties,
  });

  return {
    label: single === undefined ? `${String(entries.length)} items` : single.name,
    groups: [
      transfer,
      organize,
      destinations,
      details,
      [
        {
          id: "delete",
          label: "Delete",
          icon: "Trash2",
          disabled: !writable,
          destructive: true,
          shortcut: "Del",
          run: props.onDelete,
        },
      ],
    ],
  };
}
