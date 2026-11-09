# Feature parity with the Alran Code TUI

The agent is always the Alran Code runtime (`alran acp`). This page records how each TUI capability reaches the editor.

| Route | Meaning |
| --- | --- |
| **ACP** | Provided by the agent over the Agent Client Protocol or Alran's ACP extensions |
| **CLI** | The extension runs an `alran` subcommand |
| **Native** | Implemented in the extension with the editor's own UI |
| **TUI** | ACP offers no equivalent, so the current Session opens in the real TUI in an integrated terminal and reattaches when the terminal closes |

`test/unit/commands.test.ts` fails if a public command in the TUI catalog has no route here.

## Slash commands

| Command | Route | In the editor |
| --- | --- | --- |
| `/help`, `/status`, `/doctor`, `/context`, `/usage`, `/skills`, `/mcp`, `/model`, `/compact` | ACP | Answered by the agent in the chat |
| `/new`, `/clear` | ACP | New Session tab |
| `/sessions`, `/resume` | ACP | Quick pick and Sessions view; history is replayed |
| `/fork` | ACP | Forks into a new tab |
| `/btw`, `/side` | ACP | Fork shown as a side tab, usable while the main turn runs |
| `/parent` | Native | Closes the side tab and returns to its parent |
| `/goal` | ACP | Goal bar and full `/goal` syntax, including `budget=` |
| `/plan` | ACP | Plan toggle; `on`, `off`, `status`, `view` |
| `/review` | ACP | Sends the TUI's review prompt |
| `/init` | ACP | Runs the runtime `init` Skill |
| `/steer` | ACP | Enter during a turn, or `/steer <message>` |
| `/queue` | Native | Client queue, see below |
| `/stop` | ACP | Stop button or `Esc` |
| `/permission` | ACP | Composer, status bar; `status`, `ask`, `auto`, `full` |
| `/retry` | Native | Retry button, or resends the last message |
| `/export` | Native | Saves the transcript as Markdown |
| `/transcript` | Native | Opens the transcript in an editor, with the editor's search |
| `/copy` | Native | Copies the last response |
| `/tasks` | ACP, TUI | Agents view lists sub-agents; background Bash tasks need the TUI |
| `/provider` | CLI | Capabilities view: list, add, remove, test, credential source, API key |
| `/plugins` | CLI | Capabilities view: list, install, enable, disable, remove, refresh sources |
| `/login`, `/logout`, `/update`, `/mascot` | CLI | Integrated terminal |
| `/reload` | Native | Restarts the agent and reattaches open Sessions |
| `/settings` | Native, TUI | Extension settings, `config.yaml`, or the TUI panel |
| `/hotkeys` | Native | Editor keyboard shortcuts |
| `/changelog` | Native, TUI | Opens the packaged changelog, or the TUI panel |
| `/quit`, `/exit` | Native | Closes the Session tab |
| `/suggestions` | Not applicable | Alran does not generate prompt suggestions for ACP clients |
| `/rewind`, `/edit`, `/rename`, `/history`, `/add-dir`, `/feedback`, `/statusline`, `/theme` | TUI | ACP has no equivalent |

Skills appear as slash commands, as in the TUI. Built-in names take priority over Skills with the same name.

## Other capabilities

| Capability | Route | In the editor |
| --- | --- | --- |
| Streaming text, reasoning, tool calls, diffs | ACP | Chat transcript |
| Programmatic Tool Calling | ACP | `run_code` groups its child calls |
| Permission requests | ACP | Inline cards, notifications, activity bar badge |
| `ask_user` questionnaires | ACP | Inline forms, including multi-select and Other |
| Plan review | ACP | Plan card, opens in an editor |
| Images | ACP | Paste, drop, or attach |
| Plugin mentions | ACP | `@` inserts the durable `plugin://` form |
| Session MCP servers | ACP | `alran.mcpServers` |
| Context and cost | ACP | Composer meter and status bar |
| System prompt overrides | CLI flags | `alran.systemPrompt` and related settings |
| `--lane` | CLI flag | `alran.lane` |
| Terminal titles, OSC notifications | Native | Status bar, tab status, `alran.notifications.*` |
| Telemetry inspection | CLI | **Alran: Show Telemetry Status**, **Preview Telemetry Payload** |
| Headless `alran exec` | Terminal | Unchanged; the extension does not wrap it |

## Editor-only additions

Change tracking with diff and revert, proposed-edit preview in the diff editor, Quick Fix and code actions, selection and terminal context, clickable file references, code block actions, and a chat tab in the editor area.

## Behaviour that differs from the TUI

These follow from what ACP exposes today. Fixing them belongs in Alran's ACP layer (`packages/tui/src/acp`).

**The queue lives in the extension.** The runtime queue (`alran/session/queue/*`) works, but ACP does not stream the turns it runs, so their output would stay invisible. The extension holds queued messages and sends each as a normal prompt. This also lets queued messages carry images. Queued messages are lost when the window closes.

**Detached turns appear by replay.** Goal auto-continuation and questionnaire continuations run without a `session/prompt`, so ACP does not stream them. The extension shows "working in the background" and replays the persisted history as they progress, so output arrives in steps rather than token by token.

**Side conversations persist.** ACP has only a normal fork, so `/btw` Sessions show up in Session lists, unlike the TUI's hidden side Sessions.

**No additional directories.** Alran's ACP layer rejects `additionalDirectories`, so `/add-dir` needs the TUI.

**Changes made by commands.** Files changed by a shell command are listed, but their original text is known only if they are tracked by Git, and revert is unavailable for them.

**Permission mode is per process.** As in Alran's ACP layer, changing it applies to every open Session in the window.
