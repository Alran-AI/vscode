# Alran Code for VS Code

Alran Code, the AI coding agent by Ottili, as an editor extension for VS Code and compatible editors (Cursor, Windsurf, VSCodium).

The extension is a client. The agent harness is the real Alran Code CLI, started as `alran acp` and driven over the [Agent Client Protocol](https://agentclientprotocol.com). Tools, permissions, Skills, Plugins, MCP, sub-agents, Goals, Sessions and model providers behave exactly as they do in the terminal, because the same runtime executes them.

## Requirements

- VS Code 1.90 or newer, or a compatible editor
- The Alran Code CLI, installed with the official script:

  ```sh
  curl -fsSL https://cdn.ottili.one/public/install.sh | bash   # macOS, Linux, WSL
  irm https://cdn.ottili.one/public/install.ps1 | iex          # Windows PowerShell
  ```

  Or with npm, on Node.js 22.19 or newer: `npm install -g @ottili/alran-code@latest`.

The extension finds `alran` on `PATH`, in your login shell's `PATH`, or in the usual install locations. Set `alran.executablePath` to use another build, including a `dist/cli.js` from a source checkout.

## Features

**Chat.** Streaming Markdown, reasoning, tool calls with inline diffs, Programmatic Tool Calling groups, several Sessions in tabs, and a chat that can also open as an editor tab.

**Context.** `@` adds files and Plugins, editors add selections with `Ctrl+Alt+L`, the Explorer and terminal add files and output, images can be pasted or dropped, and the current file is shared unless you turn it off.

**Control while it works.** Enter steers the running turn, `Ctrl+Enter` queues a follow-up, `Esc` stops. Queued messages can be edited, removed, or sent immediately.

**Decisions.** Permission requests appear as cards with a preview and an **Open diff** button, questions as forms, and a badge shows what is waiting for you.

**Modes and models.** Plan Mode (`Shift+Tab`), permission mode (`Alt+M`), model, and thinking effort, in the composer and the status bar.

**Editor integration.** The Changes view lists what a Session changed, with a real diff and per-file or full revert. Also: Quick Fix and code actions, context menus, clickable file references, and code blocks you can copy, insert, open, or paste into a terminal.

**Sessions and Goals.** Resume, fork, side conversations (`/btw`), Goals with budgets, sub-agent overview, export, and transcripts.

**Capabilities.** Browse Skills and MCP servers, install and manage Plugins, add and test model providers.

Every TUI slash command works from the chat. [docs/feature-parity.md](docs/feature-parity.md) lists how each one is implemented.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+A` | Open the chat |
| `Ctrl+Alt+N` | New Session |
| `Ctrl+Alt+L` | Add the selection to the chat |
| `Ctrl+Alt+E` | Explain the selection |
| `Ctrl+Alt+M` | Choose a model |
| `Ctrl+Alt+P` | Toggle Plan Mode |
| `Ctrl+Alt+Backspace` | Stop the running turn |

On macOS, use `Cmd` in place of `Ctrl`. In the composer: `Shift+Tab` toggles Plan Mode, `Alt+M` cycles the permission mode, `Esc` stops, and `↑` recalls earlier messages.

## Settings

| Setting | Purpose |
| --- | --- |
| `alran.executablePath`, `alran.nodePath` | Which CLI and Node.js to run |
| `alran.env` | Extra environment for the agent, such as `ALRAN_DATA_DIR` |
| `alran.systemPrompt`, `alran.appendSystemPrompt`, and their `File` variants | Launch-scoped prompt overrides |
| `alran.mcpServers` | MCP servers added to Sessions opened from this editor |
| `alran.chat.enterWhileRunning` | Whether Enter steers or queues during a turn |
| `alran.chat.sendShortcut`, `alran.chat.showThinking` | Composer and transcript behaviour |
| `alran.context.includeActiveFile` | Share the current file by default |
| `alran.notifications.when`, `alran.notifications.events` | Notifications, matching the TUI's options |
| `alran.confirmFullAccess` | Confirm before enabling Full Access |

Everything else, including providers, permission rules, and `beta.ptc`, stays in Alran's own `config.yaml` (**Alran: Open config.yaml**), shared with the TUI.

## Privacy and safety

The extension collects no telemetry and talks only to the local `alran` process. API keys entered in the provider wizard reach the CLI through its environment, never its command line, and the CLI stores them.

The extension is disabled in Restricted Mode and needs a trusted workspace, because it runs an agent that can read files and execute commands. Full Access asks for confirmation first.

## Development

```sh
pnpm install
pnpm build              # dist/extension.cjs and dist/webview
pnpm typecheck
pnpm test:unit
pnpm test:integration   # real alran + scripted model; set ALRAN_TEST_CLI or keep ../alran-code built
xvfb-run -a pnpm test:e2e   # real VS Code + real alran + scripted model
pnpm package            # alran-vscode-<version>.vsix
```

Press `F5` to launch an Extension Development Host. `src/shared` and `src/core` have no VS Code imports, so the protocol layer is tested against the real CLI in plain Node.
