import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runTests } from '@vscode/test-electron';

import { createFixture } from '../fixtures/fakeModel';
import { createFakeOttili } from '../fixtures/fakeOttili';

/** Launches real VS Code with the extension, the real CLI, and a scripted model. */
async function main(): Promise<void> {
  const fixture = await createFixture();
  const ottili = await createFakeOttili({ upstream: fixture.modelOrigin });
  const root = process.cwd();
  const marketing = Boolean(process.env.ALRAN_E2E_MARKETING_DIR);
  mkdirSync(path.join(fixture.workspace, '.vscode'), { recursive: true });
  writeFileSync(
    path.join(fixture.workspace, '.vscode', 'settings.json'),
    JSON.stringify({
      'alran.executablePath': process.env.ALRAN_E2E_NO_CLI ? path.join(fixture.workspace, 'missing', 'alran') : fixture.cliPath,
      'alran.notifications.when': 'never',
      'workbench.startupEditor': 'none',
      'security.workspace.trust.enabled': false,
      'window.restoreWindows': 'none',
      // Quieter chrome for the README shots and the tests alike.
      'editor.minimap.enabled': false,
      'breadcrumbs.enabled': false,
      'workbench.layoutControl.enabled': false,
      'window.commandCenter': false,
      'window.title': '${rootName}',
      ...(marketing ? { 'chat.disableAIFeatures': true } : {}),
    }),
  );
  const userData = path.join(path.dirname(fixture.workspace), 'vscode-user');
  if (marketing) {
    // A larger UI, so the shots stay readable at README width.
    mkdirSync(path.join(userData, 'User'), { recursive: true });
    writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'window.zoomLevel': 1, 'telemetry.telemetryLevel': 'off' }));
  }
  try {
    await runTests({
      version: process.env.ALRAN_TEST_VSCODE ?? 'stable',
      extensionDevelopmentPath: process.env.ALRAN_E2E_EXTENSION_PATH ?? root,
      extensionTestsPath: path.join(root, 'dist-test', 'suite', 'index.cjs'),
      launchArgs: [
        fixture.workspace,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-workspace-trust',
        '--disable-extensions',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${userData}`,
      ],
      extensionTestsEnv: {
        ...fixture.env,
        ...ottili.env,
        ALRAN_E2E_OTTILI: ottili.origin,
        ALRAN_TEST_OPEN_EXTERNAL_LOG: path.join(path.dirname(fixture.workspace), 'opened-urls.txt'),
        ALRAN_E2E_ONLY: process.env.ALRAN_E2E_ONLY ?? '',
        ALRAN_E2E_NO_CLI: process.env.ALRAN_E2E_NO_CLI ?? '',
        ALRAN_E2E_MARKETING_DIR: process.env.ALRAN_E2E_MARKETING_DIR ?? '',
        ALRAN_E2E_STORE: process.env.ALRAN_E2E_STORE ?? '',
        ALRAN_E2E_WORKSPACE: fixture.workspace,
        ALRAN_E2E_SCREENSHOT_DIR: process.env.ALRAN_E2E_SCREENSHOT_DIR ?? '',
      } as Record<string, string>,
    });
  } finally {
    await ottili.close();
    await fixture.cleanup();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
