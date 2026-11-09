import { rmSync } from 'node:fs';
import path from 'node:path';

import * as esbuild from 'esbuild';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');
const tests = args.has('--tests');

const shared = {
  bundle: true,
  logLevel: 'warning',
  sourcemap: !production,
  minify: production,
  legalComments: 'none',
};

const extension = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
};

const webview = {
  ...shared,
  entryPoints: { main: 'src/webview/index.tsx' },
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.ttf': 'copy' },
  assetNames: '[name]',
};

/** The webview links one stylesheet: codicons followed by the chat styles. */
const combineCss = {
  name: 'combine-css',
  setup(build) {
    build.onResolve({ filter: /^codicon\.css$/ }, () => ({
      path: path.resolve('node_modules/@vscode/codicons/dist/codicon.css'),
    }));
  },
};

const testBundles = {
  ...shared,
  sourcemap: true,
  entryPoints: { runE2e: 'test/e2e/runE2e.ts', 'suite/index': 'test/e2e/suite/index.ts' },
  outdir: 'dist-test',
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
};

async function main() {
  if (tests) {
    await esbuild.build(testBundles);
    return;
  }
  if (production) rmSync('dist', { recursive: true, force: true });
  const webviewConfig = { ...webview, plugins: [combineCss] };
  if (watch) {
    const contexts = await Promise.all([esbuild.context(extension), esbuild.context(webviewConfig)]);
    await Promise.all(contexts.map((context) => context.watch()));
    return;
  }
  await Promise.all([esbuild.build(extension), esbuild.build(webviewConfig)]);
}

await main();
