# Changelog

## 1.0.1

Claude runs on your own Anthropic key. Needs the Alran CLI release that goes with it (the older one still works, and says "needs purchased credit" where the new one says what Claude really needs).

### Changed

- **Claude is billed by Anthropic, not by Ottili.** The Ottili gateway no longer resells Claude: it holds the Anthropic API key you add (once, in the Ottili AI Platform under Settings → Provider keys) and Anthropic bills your own account. Ottili charges nothing for Claude and the 4.5 % service fee is gone. Werk is unchanged.
- **A new command, *Alran: Add or Replace Your Anthropic Key*,** opens the page where the key lives; the Account view has an *Anthropic key* row (hint and state of the key, a warning when none is stored or Anthropic rejected it) with the same button, and the Account toolbar too.
- **The model picker** says *Needs your Anthropic key* or *Anthropic rejected your key* instead of "needs purchased credit", and offers **Add Anthropic Key** before it switches to a model that cannot run yet.
- **Failure cards that mean what they say.** A Claude turn that fails on the key shows *Claude needs your Anthropic key* or *Anthropic does not accept your API key* with **Add your Anthropic key** and **Switch to Ottili Werk**; an Anthropic account without credit says so and points to the Anthropic Console, not to Ottili credit.
- **The Account view** lists Claude's tokens as *billed by Anthropic* and totals only what Ottili charged (*Charged by Ottili this month*). Purchased credit is for Werk.
- The walkthrough, the README and the welcome text no longer say Claude needs purchased credit or carries a fee.

## 1.0.0

The first public release. Needs the Alran CLI 0.9.0 or newer.

### One surface, not six panels

- The side bar is one designed chat, not a chat above five collapsible editor panels. **Chat, Sessions, Changes, Agents, Capabilities** and **Account** are tabs along the top of it (a badge counts changed files and running sub-agents), and the same tabs appear when the chat is open as an editor tab, so it can sit wherever you want it.
- The agent and the first session start with the editor. The model picker is there when you open the chat and the first message goes out at once. If the agent cannot start, the chat says why and offers a retry, instead of staying silent.
- The speed of the model shows next to the context meter and in the status bar while a turn runs (`⚡ 211 tok/s`). It is the figure the CLI measures, the one its terminal UI shows: the provider's output tokens over the decode time, updated when a model call is done. A CLI older than this release does not send it; the extension then estimates it from the streamed text and marks it with a `~`.
- A session you open in the terminal says so, and comes back by itself when you close it there. **Reconnect** no longer restarts the whole agent.
- The Account tab names the installed extension version.

### A look of its own

- **The ribbon.** Alran's mark (two ribbons of brushed steel) is the interface's one colour: silver on a dark theme, graphite on a light one. Primary buttons, the chosen option of a question, the open tab and the counts use it; warnings, errors and success keep the editor's colours, and high-contrast themes keep their own. The mark itself appears on the welcome and sign-in screens, and, while Alran works, its light travels across it instead of a spinner turning.
- **The marketplace icon** is the ribbon itself, without a square around it, so it sits on the marketplace in either theme; in the editor the mark is the flat ribbon, silver on a dark theme and graphite on a light one.
- **Turns, not boxes.** Your prompt is the heading of its turn, with a hairline between turns; tool calls that follow each other hang on a thin thread.
- **Figures are set in the editor's mono face** with tabular digits (time, tokens per second, context, `+/−`, counts), so they do not jitter while they change.
- Softer corners on cards, code and the composer, a brushed highlight on the composer's top edge, a quiet send button while there is nothing to send, and one underline instead of two.

### A calmer chat

- **What you typed is kept.** A draft (text, files, images) survives a visit to another tab of the chat, switching between session tabs, and a restart of the agent. A closed session forgets its draft.
- **The Chat tab tells you what is going on.** A pulsing dot means Alran is working in some session; a yellow dot means one is waiting for your answer, on every page. When a permission request or a question is below the visible part of a long conversation, an **Alran is waiting for you** button takes you there; otherwise the button is **Jump to latest**.
- **Quieter history.** Runs of three or more reads and searches fold into one line (*Read 4 files, searched 2 times*) that opens into the calls. Edits show their `+3 −1` and have an **Open diff** button on the row. A permission request you already answered shrinks to one line, with *Show details* for the preview.
- **A working line with a clock.** *Working… 42s*, or *Thinking*, *Writing*, *Waiting for you*.
- **The `/` menu finds what you meant.** Commands that start with what you typed come first, the typed part is marked, the selection scrolls into view with the arrow keys, and a command that does not exist says so (Enter still sends the text, so a path such as `/usr/bin` is not swallowed).
- **Your own messages** have *Copy* and *Use as a new message*; a pasted log or stack trace is folded with *Show more*. Copying answers in place (the button shows a check) and the buttons are reachable with the keyboard.
- **A failed tool call says why** in one line under its row, without opening it.
- **Changes** names how many lines each file gained and lost (`+14 −3`); once earlier sessions exist, the open ones sit under **Open now**.
- **Command palette:** *Show Changes*, *Show Sessions*, *Show Sub-Agents* and *Show Skills, MCP Servers, Plugins and Providers* open the tabs of the chat directly.
- **The status bar** turns yellow and says *Alran: waiting for you* when a session needs an answer, warns from 80 % context, and its tooltips say what a click does.
- **Images and drops.** Attached images show a thumbnail; dragging files onto the composer shows a drop zone.
- **Context meter** is a ring; at 80 % it turns yellow and a click compacts the conversation.
- **Pages:** the long lists (Sessions, Capabilities) have a filter box (`Esc` clears it); groups show how many they hold; the arrow keys, `Home` and `End` move between rows and open or close groups; loading shows placeholders instead of a spinner; the filter does not follow you to another page.
- **Questions** from Alran: the whole row of an option is the click target and the chosen option is highlighted.
- **Starting points** on the welcome screen are cards with a line of explanation. The sub-agent bar has a **Show** button, and a Goal with a token budget shows a progress line.
- **Keyboard and accessibility:** the tabs of the chat and the *More actions* menu work with the arrow keys, `Home`, `End` and `Esc` (the menu scrolls in a short window); a draft or file sent from the editor while another tab is open now brings the chat forward instead of getting lost; `prefers-reduced-motion` stops spinners and animations; high-contrast themes keep the status marks visible.

### Safer by default

- A project can no longer choose what the extension runs. `alran.executablePath`, `alran.nodePath`, `alran.env`, `alran.lane`, `alran.mcpServers` and `alran.confirmFullAccess` are read from your user settings only; a value in a folder's `.vscode/settings.json` is ignored. Set them in your own settings.
- **Paste into terminal** types a one-line command into Alran's own terminal and never presses Enter. A command with more than one line is copied instead, to paste once you have read it.
- A file link in the chat opens inside the workspace; one that leads outside asks first and shows the real path. Raw HTML in a reply is shown as text.
- Without an open folder the agent works in an empty scratch folder of its own, not in your home directory.

### Plugin Store and Skill Library

- **Alran: Browse Plugin Store…** and **Browse Skill Library…** open the Store of the CLI in the editor: Plugins, the Skill Library (grouped, with Alran's built-in Skills last), what is installed and the stores it reads. Type to search, **Enter** installs or updates, buttons show details, switch a Plugin on or off and remove it.
- `/plugin` (also `/plugins` and `/store`) and `/skills library [words]` open it from the chat. The *Plugins* group of the Capabilities view has the same entry.
- A Plugin that runs commands or connects to services is shown to you first, with each MCP server command, hook and connector, and is installed only after you approve. The same approval applies when you install from the Capabilities view or by name.
- **Alran: Add Plugin Store…** adds a store; a store that cannot be read is reported in the list instead of hiding the others.
- After a change the extension offers a **New Chat**, because Skills and Plugins load when a chat starts. *Reload Agent* no longer claims to reload Plugins.
- **Alran: Slash Commands…** focuses the composer with the command menu open.

### Ottili account

- Sign in from the editor: the browser flow on this machine, a device code in remote and web windows, or an Ottili API key. No terminal needed, and sign-in can be cancelled.
- New **Account** view: name, company, project, default model, welcome and purchased credit, this month's spending per model, plan and payment method, CLI version and updates.
- Switch company, choose a project, set the default model, add credit and open billing from the view or the command palette.
- Your Ottili account appears in the editor's **Accounts** menu; signing out there revokes the session at the Ottili Platform.
- Bring-your-own-key setups and Ottili API keys are recognised and shown as such.

### Models

- The model picker shows each model's price, whether your credit covers it, and the thinking variants; the star sets the default for new sessions.
- Choosing a model your credit does not cover asks first and offers to add credit.

### Errors

- Failed turns become cards that say what happened and offer the next step: switch to Werk, add credit, sign in again, try again, choose another model, open provider settings, compact the conversation, or show the logs.
- A startup failure explains itself (old Node.js, broken installation, missing permissions) with a fitting action.
- Account commands distinguish *signed out*, *offline*, *rate limited* and *out of credit*.
- Concurrent first runs on a fresh data directory no longer fail on the CLI's database migration.

### Editor integration

- `@alran` in the VS Code Chat view, with streaming answers, tool progress, changed files as references, permission buttons and a hand-off to the Alran panel.
- *Alran Code* terminal profile for the full terminal UI.
- Redesigned connection, sign-in and welcome screens with suggestions; the composer explains why it is disabled.
- The Alran CLI is required: when it is missing, the extension says so right after startup (not only in the chat) and offers to install it with the official script or npm, or to point the extension at an existing installation.
- The provider wizard validates its input, explains the API formats and can test and select the new provider in one step.
- Windows shortcuts use `Ctrl+Shift+Alt`, so they no longer swallow `AltGr` characters such as `@`, `€` and `µ`.
- New icon in the Alran brand, in the Marketplace, the activity bar and the editor.
- Screenshots in the README are produced by the end-to-end suite, so they show the shipped UI.

## 0.1.0

Internal preview: Alran Code in VS Code and compatible editors, driven over the Agent Client Protocol.
