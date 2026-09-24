# Claude Design

Work on [Claude Design](https://claude.ai/design) projects without leaving bb.
Link each Claude Design project to the bb project it belongs to, open it in
bb's own browser beside the chat, and hand the pin comments queued with
**Send to Claude** to an agent that fixes them through the `claude-design`
MCP server.

## What you get

- **A Claude Design page** in the sidebar: your saved projects, each with
  **Open**, **Hand comments to new chat**, a bb project picker, and a menu
  with *Make default*, *Copy link* and *Remove* (with undo). Paste a project
  link to add one. **Open Claude Design** in the title bar opens its home.
- **A button in the thread header** of every thread whose bb project has a
  linked Claude Design project. It opens that project in the thread's browser
  panel, next to the chat. Threads of other projects show nothing.
- **Two controls in bb's browser toolbar**, shown only while a tab is on a
  Claude Design project page (desktop app). The project comes straight from
  the address, no linking needed:
  - **Comments** puts the hand-off prompt for that project in the thread's
    composer (outside a thread: in a new chat).
  - **Link** makes it the project the thread's bb project opens. It saves the
    project first when needed, named after the tab title.
- **Claude Design comments** in the composer's **+** menu: inserts the hand-off
  prompt for the linked project into the draft. You review it and press send.
- **Claude Design** in a thread's right-panel **+** launcher (next to *Start
  side chat* and *Start terminal*), and the command palette command
  **Claude Design: Open this thread's project**. Both open the linked project,
  or Claude Design's home when none is linked.
- **`bb claude-design`** for agents and the terminal, and the
  `claude-design-comments` skill that tells agents how to work the queue.

## Requirements

- bb 0.43 or newer.
- Claude Code with the **`claude-design` MCP server** connected and signed in
  (`claude mcp list` should show it). The agent does all Claude Design work
  through its tools (`list_comments`, `read_file`, `finalize_plan`,
  `write_files`, `render_preview`, `ack_comments`, …); the plugin itself never
  calls Claude Design and holds no credentials.
- For the side-by-side view: the bb **desktop app**, signed in to claude.ai in
  bb's browser (below).

## Install

```sh
bb plugin install path:"/home/coder/Work/3. projects/BB Plugins" --plugin claude-design --yes
```

Then add your projects on the Claude Design page, or from a terminal:

```sh
bb claude-design add https://claude.ai/design/p/<id> --name "My Design System" --project proj_xxxxxxxxxx
```

## Opening Claude Design next to the chat

claude.ai does not allow itself to be embedded in a frame, so the plugin
never embeds it. Every "open" goes through bb's link handling instead, which
follows one client setting:

**Settings → General → Links → Open links in the in-app browser** — shown
only in the desktop app, on by default, remembered per client.

- On (desktop app): links open as a tab in bb's browser. From a thread (header
  button, launcher row, palette command, toolbar) the tab lands in that
  thread's right panel beside the chat; from the Claude Design page, in that
  page's right panel.
- Off, or any browser client such as bb on a phone: links open a normal
  browser tab.

bb's browser keeps its own cookies. Sign in to claude.ai there once, or import
your sign-ins from Chrome (or another installed browser) in
**Settings → Browser → Browsers**.

## Using Claude Design without a VPN

bb's browser runs on your Mac, so claude.ai sees the Mac's address and may
refuse your country. The **Use Claude Design without a VPN** card on the
Claude Design page sends only Claude's domains through the bb server instead:

- a login item (launchd) keeps an SSH tunnel to the server open: a SOCKS proxy
  on `127.0.0.1:39891` for Claude's traffic, and a forward on `127.0.0.1:39892`
  through which the Mac reads the routing rule;
- the plugin serves that rule (a PAC file at `/api/v1/plugins/claude-design/http/proxy.pac`):
  `claude.ai`, `claude.com`, `anthropic.com`, `claudeusercontent.com`,
  `claudemcpcontent.com`, `claude.site`, and `challenges.cloudflare.com` go
  through the tunnel, everything else stays direct;
- macOS network services point at the rule as their automatic proxy
  configuration. A service that already uses a different automatic proxy (a
  corporate one, for example) is skipped.

Enter the SSH login you use from the Mac (`user@host`), copy the command, and
paste it into Terminal once; it asks for the Mac password to change the
network setting. The card shows when a Mac last read the rule. The **Undo**
command removes the login item and turns the setting off again. Safari,
Chrome, and the Claude apps on that Mac use the same route.

## Linking and the default project

Each saved Claude Design project can be linked to one bb project. A bb project
can have several linked; one of them is its **default**, the one its threads
open and hand off. The first link becomes the default; *Make default* (page
menu), **Link** (browser toolbar) or `--default` (CLI) switch it. Unlinking or
removing the default promotes the most recently linked of the others. bb's
personal project (threads outside a project) cannot be linked.

## Handing comments to an agent

1. In Claude Design, leave pin comments and press **Send to Claude** on them.
2. In bb, pick **Claude Design comments** from the composer's + menu (or
   **Comments** in the browser toolbar, or **Hand comments to new chat** on the
   page) and send the prompt.
3. The agent follows the `claude-design-comments` skill: reads the queue with
   `list_comments` (`queued_for_claude: true`), acts on your own comments and
   asks before acting on anyone else's, reads files in full and writes with
   etags after `get_claude_design_prompt` and `finalize_plan`, checks the
   result with `render_preview` (it never shows you the tokenized
   `serve_url`), acks only what it handled, and reports what changed with the
   project link.

When the thread's bb project has no linked Claude Design project, the + menu
item still works: its prompt tells the agent to run `bb claude-design current`,
and if that finds nothing, to list the saved projects and ask you which one to
use. A toast offers to open the page to link one, so the next time is direct.
**Hand comments to new chat** starts in the project selected in the new-thread
composer; the prompt names the Claude Design project, so any project works.

## `bb claude-design`

| Command | What it does |
| --- | --- |
| `projects [--json]` | Saved projects and their bb links |
| `add <link> [--name <name>] [--project <proj id>] [--default] [--json]` | Save a project; for a saved one, `--name` renames it and `--project` links it |
| `link <project> [--project <proj id>] [--default] [--json]` | Link to a bb project; defaults to the invoking thread's |
| `unlink <project> [--json]` | Remove the link, keep the project |
| `remove <project> [--json]` | Forget the project |
| `current [--project <proj id>] [--json]` | The Claude Design project linked to this thread's bb project |

`<link>` is `https://claude.ai/design/p/<id>` (query and hash allowed) or the
bare id. `<project>` is a saved project's id, a 6+ character id prefix, its
link or its exact name. Every command answers `--help`; with `--json`, errors
come as `{"ok": false, "error": {code, message, hint}}`.

## How it works

```
server.ts                 kv-stored project list, RPC, the CLI, realtime signal
contract.ts               RPC contract and schemas
lib/links.ts              link parsing and the hand-off prompt (server and app)
lib/project-list.ts       list operations and the one-default-per-project rule
lib/store.ts              the app's shared copy of the list
lib/actions.ts            + menu row, launcher row, palette command
components/ProjectsPage   the sidebar page
components/HeaderAction   thread header button
components/BrowserAction  browser toolbar controls
components/ThreadPanel    panel tab, used when the header is not mounted
components/Bridge         invisible app overlay: realtime refresh, RPC and
                          navigation for callbacks that run outside React
skills/                   claude-design-comments, the agent procedure
```

Saved projects live in the plugin's key-value storage on the bb server (one
list per installation). Every change publishes a `projects-changed` realtime
signal, so an open page follows edits made by an agent through the CLI.

## Known limits

- No embedding: claude.ai forbids framing, so Claude Design always opens as a
  browser tab — bb's own in the desktop app, a normal one elsewhere.
- The browser toolbar controls exist only in the desktop app, which is the
  only client with bb's browser. They are plain buttons, because a menu
  opened over the page would be hidden behind it.
- The plugin never talks to Claude Design and cannot see comments itself; the
  agent does, through the `claude-design` MCP server in Claude Code. Threads on
  a provider without that MCP server cannot process the queue.
- Opening a link twice opens two browser tabs; bb decides tab reuse.
- Several APIs used here (thread header, browser toolbar, app overlay) are
  experimental in bb's plugin SDK and may change between bb releases.
