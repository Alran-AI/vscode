/** `/mcp` prints one `- name — state · transport — description` line per server. */
export function parseMcpList(output: string): Array<{ name: string; detail: string; enabled: boolean }> {
  return output.split('\n').flatMap((line) => {
    const match = /^- (.+?) — (enabled|disabled) · (.+)$/u.exec(line);
    if (!match?.[1] || !match[3]) return [];
    return [{ name: match[1], enabled: match[2] === 'enabled', detail: match[3] }];
  });
}
