import { randomUUID } from 'node:crypto';
import path from 'node:path';

import * as vscode from 'vscode';

import type { ComposerAttachment, MentionCandidate } from '../shared/types';

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const SEARCH_EXCLUDE = '**/{node_modules,.git,dist,out,build,.next,.turbo,target,__pycache__,.venv}/**';
const MAX_MENTION_RESULTS = 30;

export function relativeLabel(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}

export function fileAttachment(uri: vscode.Uri): ComposerAttachment {
  return { kind: 'file', id: randomUUID(), path: uri.fsPath, label: relativeLabel(uri) };
}

export function selectionAttachment(editor: vscode.TextEditor): ComposerAttachment | undefined {
  const { document, selection } = editor;
  if (selection.isEmpty) return undefined;
  const startLine = selection.start.line + 1;
  // A selection ending at column 0 stops on the previous line for the reader.
  const endLine = selection.end.character === 0 ? selection.end.line : selection.end.line + 1;
  const label = `${relativeLabel(document.uri)}:${String(startLine)}-${String(endLine)}`;
  return {
    kind: 'selection',
    id: randomUUID(),
    path: document.uri.fsPath,
    label,
    text: document.getText(selection),
    language: document.languageId,
    startLine,
    endLine,
  };
}

export function textAttachment(label: string, text: string): ComposerAttachment {
  return { kind: 'text', id: randomUUID(), label, text };
}

/** Files or images the user picked; images are inlined for the prompt. */
export async function attachmentsFromUris(uris: readonly vscode.Uri[]): Promise<ComposerAttachment[]> {
  const attachments: ComposerAttachment[] = [];
  for (const uri of uris) {
    const mimeType = IMAGE_TYPES[path.extname(uri.fsPath).toLowerCase()];
    if (mimeType) {
      const bytes = await vscode.workspace.fs.readFile(uri);
      attachments.push({
        kind: 'image',
        id: randomUUID(),
        label: path.basename(uri.fsPath),
        mimeType,
        data: Buffer.from(bytes).toString('base64'),
      });
    } else {
      attachments.push(fileAttachment(uri));
    }
  }
  return attachments;
}

export function formatDiagnostics(
  document: vscode.TextDocument,
  diagnostics: readonly vscode.Diagnostic[],
): string {
  return diagnostics
    .map((diagnostic) => {
      const line = diagnostic.range.start.line + 1;
      const severity = vscode.DiagnosticSeverity[diagnostic.severity];
      const source = diagnostic.source ? ` (${diagnostic.source})` : '';
      return `${relativeLabel(document.uri)}:${String(line)} ${severity}${source}: ${diagnostic.message}`;
    })
    .join('\n');
}

function escapeGlob(value: string): string {
  return value.replace(/[[\]{}()*?!]/gu, '\\$&');
}

export async function findFileMentions(query: string): Promise<MentionCandidate[]> {
  const trimmed = query.trim();
  const openFiles = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .flatMap((tab) => (tab.input instanceof vscode.TabInputText ? [tab.input.uri] : []))
    .filter((uri) => uri.scheme === 'file');
  const pattern = trimmed
    ? `**/*${escapeGlob(trimmed).replace(/\s+/gu, '*')}*`
    : '**/*';
  const found = await vscode.workspace.findFiles(pattern, SEARCH_EXCLUDE, MAX_MENTION_RESULTS);
  const needle = trimmed.toLowerCase();
  const seen = new Set<string>();
  return [...openFiles.filter((uri) => relativeLabel(uri).toLowerCase().includes(needle)), ...found]
    .filter((uri) => {
      if (seen.has(uri.fsPath)) return false;
      seen.add(uri.fsPath);
      return true;
    })
    .slice(0, MAX_MENTION_RESULTS)
    .map((uri) => ({
      kind: 'file',
      label: path.basename(uri.fsPath),
      detail: relativeLabel(uri),
      value: uri.fsPath,
    }));
}

/** Lightbulb entries that hand a problem or selection to the agent. */
export class AlranCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (document.uri.scheme !== 'file') return [];
    const actions: vscode.CodeAction[] = [];
    if (context.diagnostics.length > 0) {
      const fix = new vscode.CodeAction('Fix with Alran', vscode.CodeActionKind.QuickFix);
      fix.command = {
        command: 'alran.fixDiagnostics',
        title: 'Fix with Alran',
        arguments: [document.uri, context.diagnostics],
      };
      fix.diagnostics = [...context.diagnostics];
      actions.push(fix);
    }
    if (!range.isEmpty) {
      const explain = new vscode.CodeAction('Explain with Alran', vscode.CodeActionKind.RefactorRewrite);
      explain.command = { command: 'alran.explainSelection', title: 'Explain with Alran' };
      const edit = new vscode.CodeAction('Ask Alran about this…', vscode.CodeActionKind.RefactorRewrite);
      edit.command = { command: 'alran.addSelection', title: 'Ask Alran about this…' };
      actions.push(explain, edit);
    }
    return actions;
  }
}
