# Changelog

## 0.2.0

The first public release. Needs the Alran CLI 0.9.0 or newer.

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
