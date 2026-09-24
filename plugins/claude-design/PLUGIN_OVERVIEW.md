Keep Claude Design one click from the chat that works on it.

## What you get

- A **Claude Design** page in the sidebar: save projects by pasting their
  link, link each one to a bb project, open it, or start a chat about it.
- A **thread header button** that opens the Claude Design project linked to
  the thread's bb project — in bb's browser, right beside the chat.
- **Browser toolbar controls** on any Claude Design project page: hand its
  queued comments to this chat, or link it to this thread's project.
- **Claude Design comments** in the composer's + menu, a row in the right
  panel's launcher, and a command palette command.
- A `bb claude-design` command and an agent skill for the whole loop.

## How it works

Pin comments you send with "Send to Claude" wait in Claude Design's queue.
The plugin hands them to an agent with a ready prompt; the agent works through
them with the claude-design MCP server in Claude Code — fixing each comment,
checking the result, marking it handled, and reporting what changed. It asks
before acting on comments someone else wrote.

The plugin itself never contacts Claude Design and stores no credentials: it
keeps the list of projects and their links on your bb server. claude.ai cannot
be embedded, so it opens in bb's browser in the desktop app (Settings →
General → "Open links in the in-app browser") and in a normal tab elsewhere.
