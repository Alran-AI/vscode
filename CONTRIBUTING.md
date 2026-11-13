# Contributing

## Development

```sh
pnpm install
pnpm build              # dist/extension.cjs and dist/webview
pnpm typecheck
pnpm test:unit
pnpm test:integration   # real alran + scripted model and Ottili Platform; set ALRAN_TEST_CLI or keep ../alran-code built
xvfb-run -a pnpm test:e2e   # real VS Code + real alran + scripted model and Ottili Platform
pnpm package            # alran-vscode-<version>.vsix
```

Press `F5` to launch an Extension Development Host. `src/shared` and `src/core` have no VS Code imports, so the protocol and account layers are tested against the real CLI in plain Node.

The end-to-end suite takes screenshots when `ALRAN_E2E_SCREENSHOT_DIR` is set, and runs a subset when `ALRAN_E2E_ONLY` holds a regular expression of step names. `ALRAN_TEST_VSCODE` picks the VS Code version (default: stable).

### Layout

| Path | Contents |
| --- | --- |
| `src/acp` | The `alran acp` process and its ACP connection; finding the CLI |
| `src/core` | Sessions, the change tracker, `alran` subcommands (`cli.ts`) and the Ottili account (`account.ts`) |
| `src/shared` | View model, slash commands, failure descriptions; shared with the webview |
| `src/host` | Everything that talks to VS Code: commands, views, the chat webview bridge, `@alran`, the Accounts menu |
| `src/webview` | The chat UI (Preact) |
| `test/fixtures` | A scripted model provider and a scripted Ottili Platform and Gateway |

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
