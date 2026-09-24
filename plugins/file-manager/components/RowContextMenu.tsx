// components/RowContextMenu.tsx — right-click menu for the current selection.
//
// Renders only the `<ContextMenuContent>`: the panel owns one Radix
// ContextMenu root around the whole table, and swaps this component for
// BackgroundContextMenu depending on where the click landed. One root avoids
// the double-open you get when a per-row trigger and a container trigger both
// see the same `contextmenu` event.
//
// What the menu offers comes from `selectedEntryActionModel`, which the touch
// surface (SelectionActionBar) shares; this file only paints it.
import { Fragment } from "react";

import { useMenuPointerGuard } from "../hooks/useMenuPointerGuard";
import {
  selectedEntryActionModel,
  type SelectedEntryActionsProps,
} from "./selected-entry-actions";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "./ui/context-menu";
import { Icon } from "./ui/icon";

export type RowContextMenuProps = SelectedEntryActionsProps;

export function RowContextMenu(props: RowContextMenuProps) {
  const model = selectedEntryActionModel(props);
  // Letting go of the right button must not run whatever it landed on.
  const pointerGuard = useMenuPointerGuard();

  return (
    <ContextMenuContent className="w-56" data-testid="fm-row-menu" {...pointerGuard}>
      <ContextMenuLabel className="truncate">{model.label}</ContextMenuLabel>
      {model.groups.map((group, groupIndex) => (
        <Fragment key={group[0]?.id ?? String(groupIndex)}>
          <ContextMenuSeparator />
          {group.map((action) => (
            <ContextMenuItem
              key={action.id}
              data-testid={action.id === "bookmark" ? "fm-row-bookmark" : undefined}
              disabled={action.disabled}
              className={
                action.destructive
                  ? "text-destructive focus:bg-destructive/15 focus:text-destructive"
                  : undefined
              }
              onSelect={action.run}
            >
              <Icon name={action.icon} className="size-4" aria-hidden="true" />
              <span data-fm-selected-action={action.id}>{action.label}</span>
              {action.trailing !== undefined || action.shortcut !== undefined ? (
                <ContextMenuShortcut>{action.trailing ?? action.shortcut}</ContextMenuShortcut>
              ) : null}
            </ContextMenuItem>
          ))}
        </Fragment>
      ))}
    </ContextMenuContent>
  );
}
