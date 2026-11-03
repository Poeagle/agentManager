import {act,render,screen,cleanup} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {memo} from 'react';
import {calibrateBrowserClock,resetBrowserClock,estimatedServerNow,formatDisplayTimestamp,browserTimestamp,useDisplayClock,browserTimeZone} from '../src/lib/display-clock';
afterEach(()=>{cleanup();resetBrowserClock();vi.restoreAllMocks();});
describe('browser display clock',()=>{
  it('aligns native events to a browser that is 90 seconds behind and preserves historical differences',()=>{
    const now=Date.now();calibrateBrowserClock(now+90000,now,0);
    expect(browserTimestamp(now+90000)).toBe(now);expect(browserTimestamp(now+30000)).toBe(now-60000);
    expect(estimatedServerNow()).toBeGreaterThanOrEqual(now+90000);
    expect(formatDisplayTimestamp('invalid')).toBe('时间未知');
    const expected=new Intl.DateTimeFormat('sv-SE',{timeZone:browserTimeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(now);
    expect(formatDisplayTimestamp(now+90000)).toBe(expected);
  });
  it('updates already mounted memoized displays when a low latency sample arrives',()=>{
    const value=Date.parse('2026-11-03T07:01:45Z'),Clock=memo(function Clock(){useDisplayClock();return <time data-testid="clock">{formatDisplayTimestamp(value)}</time>;});
    render(<Clock/>);const before=screen.getByTestId('clock').textContent;
    act(()=>calibrateBrowserClock(value+90000,value,0));expect(screen.getByTestId('clock').textContent).not.toBe(before);
    const time=screen.getByTestId('clock').textContent;act(()=>calibrateBrowserClock(value+999999,value,500));expect(screen.getByTestId('clock').textContent).toBe(time);
  });
  it('accounts for return latency and rejects invalid or very slow samples',()=>{
    calibrateBrowserClock(100000,100000,200);expect(browserTimestamp(100100)).toBe(100000);
    calibrateBrowserClock(NaN,100000,0);calibrateBrowserClock(100000,100000,11000);expect(browserTimestamp(100100)).toBe(100000);
  });
});
