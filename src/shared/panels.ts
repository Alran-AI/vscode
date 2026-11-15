/**
 * The pages of the Alran side bar besides the chat: sessions, changes, sub-agents, capabilities and
 * the account. They are plain rows in the chat webview, not editor tree views, so the whole product
 * is one designed surface that can also be opened as an editor tab.
 *
 * Pure view model: no `vscode` and no Node imports (see `types.ts`).
 */

export type PanelPage = 'sessions' | 'changes' | 'agents' | 'capabilities' | 'account';

export const PANEL_PAGES: readonly PanelPage[] = ['sessions', 'changes', 'agents', 'capabilities', 'account'];

export interface PanelAction {
  readonly id: string;
  readonly label: string;
  /** A codicon name. */
  readonly icon: string;
}

export interface PanelRow {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  /** A codicon name; a trailing `~spin` spins it. */
  readonly icon?: string;
  /** The row does something when clicked. */
  readonly clickable: boolean;
  /** Small buttons shown at the end of the row. */
  readonly actions: readonly PanelAction[];
  readonly children?: readonly PanelRow[];
  /** A group heading (skills, plugins...). */
  readonly group?: boolean;
  /** Informational line, not an item. */
  readonly note?: boolean;
}

export interface PanelView {
  readonly page: PanelPage;
  readonly title: string;
  readonly rows: readonly PanelRow[];
  /** Page-level buttons (refresh, revert all...). */
  readonly toolbar: readonly PanelAction[];
  /** Shown when there are no rows. */
  readonly empty?: string;
  /** Actions offered under the empty text. */
  readonly emptyActions?: readonly PanelAction[];
  readonly loading?: boolean;
}

/** What the navigation needs to know without opening a page. */
export interface PanelBadges {
  readonly changes: number;
  readonly agents: number;
}
