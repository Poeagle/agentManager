import {it,expect} from 'vitest';
import {applyNativeTabTitles} from '../src/lib/project-session-state';
it('uses native titles only for automatic tabs and maintains unique names',()=>{
 const tabs=[{id:'a',label:'Session 1'},{id:'b',label:'Session 2'},{id:'c',label:'Session 3',customLabel:'My name'}];const titles={a:'Native title',b:'Native title',c:'Override'};const next=applyNativeTabTitles(tabs,titles);expect(next.map(t=>t.label)).toEqual(['Native title','Native title (2)','Session 3']);expect(next[2].customLabel).toBe('My name');expect(applyNativeTabTitles(next,titles)).toEqual(next);
});
