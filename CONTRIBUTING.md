# Contributing

## Development

```sh
pnpm install
pnpm build              # dist/extension.cjs and dist/webview
pnpm typecheck
pnpm test:unit
pnpm sync:tui           # refresh test/fixtures/tui-commands.json from ../alran-code
pnpm test:integration   # real alran + scripted model and Ottili Platform; set ALRAN_TEST_CLI or keep ../alran-code built
xvfb-run -a pnpm test:e2e   # real VS Code + real alran + scripted model and Ottili Platform
pnpm package            # alran-vscode-<version>.vsix
```

Press `F5` to launch an Extension Development Host. `src/shared` and `src/core` have no VS Code imports, so the protocol and account layers are tested against the real CLI in plain Node.

The end-to-end suite takes screenshots when `ALRAN_E2E_SCREENSHOT_DIR` is set, and runs a subset when `ALRAN_E2E_ONLY` holds a regular expression of step names. `ALRAN_TEST_VSCODE` picks the VS Code version (default: stable). `ALRAN_TEST_CLI` points the integration and end-to-end tests at a CLI, for example the published package (`npm install alran` into a scratch folder) instead of a build of `../alran-code`.

Every test uses a tiny offline store (`test/fixtures/store`, built from `test/fixtures/store-src`, see its README), so no test asks the network for one.

### README screenshots

The screenshots in `media/screenshots` come from the end-to-end suite, so they always show the shipped UI. Run the sign-in step and the capture steps in a window of exactly 1440 × 900:

```sh
ALRAN_E2E_ONLY='signs in with a device|captures the' \
ALRAN_E2E_MARKETING_DIR=/some/empty/dir \
ALRAN_E2E_STORE=../alran-store/store \
ALRAN_E2E_ROOT=/tmp/dev ALRAN_E2E_PROVIDER=local \
xvfb-run -a -s "-screen 0 1440x900x24" pnpm test:e2e
```

`ALRAN_E2E_STORE` shows a real store instead of the test store, `ALRAN_E2E_ROOT` gives the scratch directory a name that can appear in a permission card (it must not exist or be empty), and `ALRAN_E2E_PROVIDER` renames the scripted model provider. The model is scripted and the Ottili account is a fake Platform, so a screenshot shows the UI, not the quality of a real model. The capture step blanks the window title (`[Extension Development Host] …`) and changes nothing else.

### Layout

| Path | Contents |
| --- | --- |
| `src/acp` | The `alran acp` process and its ACP connection; finding the CLI |
| `src/core` | Sessions, the change tracker, `alran` subcommands (`cli.ts`) and the Ottili account (`account.ts`) |
| `src/shared` | View model, slash commands, failure descriptions; shared with the webview |
| `src/host` | Everything that talks to VS Code: commands, views, the chat webview bridge, `@alran`, the Accounts menu |
| `src/webview` | The chat UI (Preact) |
| `src/core/store.ts`, `src/host/store.ts` | The Plugin Store and Skill Library: CLI calls and the Quick Pick |
| `test/fixtures` | A scripted model provider, a scripted Ottili Platform and Gateway, a tiny offline store and a snapshot of the TUI's commands |

## Releasing

1. Update `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Run the checks above, including the end-to-end suite.
3. `pnpm package`, then install the `.vsix` in a clean VS Code profile and try sign-in, a task and the Account view.
4. Publish the same `.vsix` to both registries:

   ```sh
   pnpm exec vsce publish --packagePath alran-vscode-<version>.vsix          # VSCE_PAT for publisher "ottili"
   npx --yes ovsx@1.4.0 publish alran-vscode-<version>.vsix                  # OVSX_PAT for namespace "ottili"
   ```

   The Visual Studio Marketplace needs the publisher `ottili` and a token with the *Marketplace (Manage)* scope; Open VSX needs the namespace `ottili` (`npx ovsx create-namespace ottili`) and an access token.
5. Push the release commit and a `v<version>` tag, so the README's relative links and images resolve on GitHub.
