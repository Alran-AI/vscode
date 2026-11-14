/** What `vscode.WorkspaceConfiguration.inspect` returns, without importing the editor API. */
export interface InspectableConfiguration {
  inspect<T>(section: string): { defaultValue?: T; globalValue?: T } | undefined;
}

/**
 * Settings that decide which program the extension starts, with which environment, and which
 * servers that program starts. A folder's `.vscode/settings.json` can set any workspace-scoped
 * setting, and a repository you open is not a source you chose to run programs from: these come
 * from the user's own settings only (the manifest declares them `machine`, which the editor
 * enforces; reading them through `userSetting` keeps that true on an editor that does not).
 */
export const USER_ONLY_SETTINGS = [
  'executablePath',
  'nodePath',
  'env',
  'lane',
  'mcpServers',
  'confirmFullAccess',
] as const;

/** The value the user set (else the default), never a workspace or folder override. */
export function userSetting<T>(config: InspectableConfiguration, section: string, fallback: T): T {
  const inspected = config.inspect<T>(section);
  return inspected?.globalValue ?? inspected?.defaultValue ?? fallback;
}
