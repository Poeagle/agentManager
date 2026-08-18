/** Return a new array with one item moved to a new index. */
export function moveItem<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex < 0
    || toIndex < 0
    || fromIndex >= items.length
    || toIndex >= items.length
    || fromIndex === toIndex
  ) return [...items];
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

/** Move an item identified by a stable key in front of another item. */
export function moveItemByKey<T>(
  items: readonly T[],
  sourceKey: string,
  targetKey: string,
  keyOf: (item: T) => string,
): T[] {
  return moveItem(
    items,
    items.findIndex((item) => keyOf(item) === sourceKey),
    items.findIndex((item) => keyOf(item) === targetKey),
  );
}

/** Apply a saved id order while retaining new/unordered items at the end. */
export function orderItemsByKeys<T>(
  items: readonly T[],
  order: readonly string[],
  keyOf: (item: T) => string,
): T[] {
  const byKey = new Map(items.map((item) => [keyOf(item), item]));
  const used = new Set<string>();
  const ordered: T[] = [];
  for (const key of order) {
    const item = byKey.get(key);
    if (!item || used.has(key)) continue;
    ordered.push(item);
    used.add(key);
  }
  for (const item of items) {
    const key = keyOf(item);
    if (used.has(key)) continue;
    ordered.push(item);
  }
  return ordered;
}
