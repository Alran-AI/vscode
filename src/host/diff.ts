import { basename } from 'node:path';

import * as vscode from 'vscode';

import { proposedEdit } from '../core/changes';
import type { SessionController } from '../core/session';
import type { PermissionItem, ToolItem } from '../shared/types';

const SCHEME = 'alran-virtual';
const MAX_DOCUMENTS = 200;

/** Read-only in-memory documents: pre-edit versions, proposed edits, plans. */
export class VirtualDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly documents = new Map<string, string>();
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
  private nextId = 1;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.query) ?? '';
  }

  /** The URI's file name keeps the original extension, which selects the language. */
  create(fileName: string, content: string): vscode.Uri {
    const id = String(this.nextId);
    this.nextId += 1;
    this.documents.set(id, content);
    if (this.documents.size > MAX_DOCUMENTS) {
      const oldest = this.documents.keys().next().value;
      if (oldest) this.documents.delete(oldest);
    }
    return vscode.Uri.from({ scheme: SCHEME, path: `/${fileName}`, query: id });
  }

  dispose(): void {
    this.registration.dispose();
    this.documents.clear();
  }
}

export async function openChangeDiff(
  documents: VirtualDocuments,
  session: SessionController,
  path: string,
): Promise<void> {
  const name = basename(path);
  const baseline = await session.changes.baseline(path);
  const fileUri = vscode.Uri.file(path);
  if (baseline === undefined) {
    await vscode.window.showTextDocument(fileUri, { preview: true });
    void vscode.window.showInformationMessage(
      `The original of ${name} was not captured and it is not in Git, so only the current file is shown.`,
    );
    return;
  }
  const left = documents.create(name, baseline ?? '');
  const exists = await fileExists(fileUri);
  const right = exists ? fileUri : documents.create(name, '');
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `${name} (changes by Alran)`,
    { preview: true } satisfies vscode.TextDocumentShowOptions,
  );
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function openToolDiff(
  documents: VirtualDocuments,
  session: SessionController,
  tool: ToolItem,
): Promise<void> {
  const path = tool.locations[0];
  if (path && session.changes.get(path)) {
    await openChangeDiff(documents, session, path);
    return;
  }
  const block = tool.blocks.find((candidate) => candidate.type === 'diff');
  if (block?.type === 'diff') {
    const name = basename(block.path);
    await vscode.commands.executeCommand(
      'vscode.diff',
      documents.create(name, block.oldText ?? ''),
      documents.create(name, block.newText),
      `${name} (${tool.name})`,
      { preview: true } satisfies vscode.TextDocumentShowOptions,
    );
    return;
  }
  if (path) await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: true });
}

/** Shows what a pending edit would do before the user allows it. */
export async function openPermissionPreview(
  documents: VirtualDocuments,
  item: PermissionItem,
): Promise<boolean> {
  const edit = await proposedEdit(item.input);
  if (!edit) return false;
  const name = basename(edit.path);
  await vscode.commands.executeCommand(
    'vscode.diff',
    documents.create(name, edit.before),
    documents.create(name, edit.after),
    `${name} (proposed by Alran)`,
    { preview: true } satisfies vscode.TextDocumentShowOptions,
  );
  return true;
}
