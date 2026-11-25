/** Project the open tabs in activity order, keeping each visible branch together. */
export function sessionTabTree<T extends {tab: {id: string}}>(
  sortedTabs: readonly T[],
  parentOf: (id: string) => string | null | undefined,
) {
  const open = new Set(sortedTabs.map(({ tab }) => tab.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const row of sortedTabs) {
    const parent = parentOf(row.tab.id);
    if (!parent || !open.has(parent) || parent === row.tab.id) {
      roots.push(row);
      continue;
    }
    const siblings = children.get(parent);
    if (siblings) siblings.push(row);
    else children.set(parent, [row]);
  }

  const visited = new Set<string>();
  function branch(root: T) {
    const rows: Array<T & {depth: number}> = [];
    const stack = [{ row: root, depth: 0 }];
    while (stack.length) {
      const { row, depth } = stack.pop()!;
      if (visited.has(row.tab.id)) continue;
      visited.add(row.tab.id);
      rows.push({ ...row, depth });
      const nested = children.get(row.tab.id) ?? [];
      for (let index = nested.length - 1; index >= 0; index--) {
        stack.push({ row: nested[index], depth: depth + 1 });
      }
    }
    return rows.map((row, index) => ({ ...row, hasChildren: (rows[index + 1]?.depth ?? -1) > row.depth }));
  }
  const branches = roots.map(branch);
  for (const row of sortedTabs) {
    if (!visited.has(row.tab.id)) branches.push(branch(row));
  }
  return branches;
}
