import { describe, expect, it } from 'vitest';
import { moveItem, moveItemByKey, orderItemsByKeys } from '../src/lib/reorder';

describe('reorder helpers', () => {
  it('moves a tab without mutating the current order', () => {
    const tabs = ['one', 'two', 'three'];
    expect(moveItem(tabs, 2, 0)).toEqual(['three', 'one', 'two']);
    expect(tabs).toEqual(['one', 'two', 'three']);
  });

  it('moves entities by stable key and ignores unknown targets', () => {
    const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(moveItemByKey(projects, 'c', 'a', (project) => project.id).map((project) => project.id))
      .toEqual(['c', 'a', 'b']);
    expect(moveItemByKey(projects, 'missing', 'a', (project) => project.id)).toEqual(projects);
  });

  it('applies saved project order and appends newly available projects', () => {
    const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(orderItemsByKeys(projects, ['c', 'a', 'missing'], (project) => project.id).map((project) => project.id))
      .toEqual(['c', 'a', 'b']);
  });
});
