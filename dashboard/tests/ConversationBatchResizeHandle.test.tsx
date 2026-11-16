import {useRef} from 'react';
import {act, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ConversationBatchResizeHandle} from '../src/components/ConversationBatchResizeHandle';

let available: number, resize: () => void;
const disconnect = vi.fn();
function Harness({active = true, storageKey = 'batch-width'}: {active?: boolean; storageKey?: string}) {
  const layout = useRef<HTMLDivElement>(null);
  return <div ref={layout} data-testid="layout"><ConversationBatchResizeHandle layout={layout} active={active} storageKey={storageKey}/></div>;
}
const handle = () => screen.getByRole('separator', {name: '调整批量待发区宽度'});
const start = () => fireEvent.pointerDown(handle(), {button: 0, clientX: 800, pointerId: 1});
beforeEach(() => {
  available = 1200;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => available);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0; }
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('batch panel width', () => {
  it('drags the divider, clamps both ends, remembers the width and resets it', () => {
    const view = render(<Harness/>);
    expect(handle()).toHaveAttribute('aria-valuenow', '290');
    start(); fireEvent.pointerMove(handle(), {clientX: 700, pointerId: 1});
    expect(screen.getByTestId('layout').style.getPropertyValue('--chat-batch-width')).toBe('390px');
    fireEvent.pointerMove(handle(), {clientX: -900, pointerId: 2});
    expect(handle()).toHaveAttribute('aria-valuenow', '390');
    fireEvent.pointerUp(handle(), {clientX: -900, pointerId: 1});
    expect(handle()).toHaveAttribute('aria-valuenow', '720');
    expect(screen.getByTestId('layout')).not.toHaveAttribute('data-batch-resize');
    view.unmount(); render(<Harness/>);
    expect(handle()).toHaveAttribute('aria-valuenow', '720');
    start(); fireEvent.pointerUp(handle(), {clientX: 1800, pointerId: 1});
    expect(handle()).toHaveAttribute('aria-valuenow', '220');
    fireEvent.doubleClick(handle());
    expect(handle()).toHaveAttribute('aria-valuenow', '290');
    expect(localStorage.getItem('batch-width')).toBeNull();
  });
  it('supports keyboard adjustments and adapts to available space without losing the preference', () => {
    render(<Harness/>);
    fireEvent.keyDown(handle(), {key: 'ArrowLeft'});
    expect(handle()).toHaveAttribute('aria-valuenow', '322');
    fireEvent.keyDown(handle(), {key: 'ArrowRight'});
    expect(handle()).toHaveAttribute('aria-valuenow', '290');
    fireEvent.keyDown(handle(), {key: 'End'});
    available = 800; act(() => resize());
    expect(handle()).toHaveAttribute('aria-valuenow', '440');
    available = 1200; act(() => resize());
    expect(handle()).toHaveAttribute('aria-valuenow', '720');
    fireEvent.keyDown(handle(), {key: 'Home'});
    expect(handle()).toHaveAttribute('aria-valuenow', '220');
    fireEvent.keyDown(handle(), {key: 'Enter'});
    expect(handle()).toHaveAttribute('aria-valuenow', '290');
  });
  it('cancels unfinished gestures on pointer cancellation, blur, deactivation and unmount', () => {
    const view = render(<Harness/>), layout = screen.getByTestId('layout');
    for (const cancel of [() => fireEvent.pointerCancel(handle()), () => fireEvent.lostPointerCapture(handle()), () => fireEvent.blur(window), () => fireEvent.keyDown(handle(), {key: 'Escape'})]) {
      start(); fireEvent.pointerMove(handle(), {clientX: 700, pointerId: 1}); cancel();
      expect(handle()).toHaveAttribute('aria-valuenow', '290');
      expect(layout).not.toHaveAttribute('data-batch-resize');
    }
    start(); fireEvent.pointerMove(handle(), {clientX: 700, pointerId: 1}); view.rerender(<Harness active={false}/>);
    expect(handle()).toHaveAttribute('aria-valuenow', '290');
    view.rerender(<Harness/>); start(); view.unmount();
    expect(layout).not.toHaveAttribute('data-batch-resize');
    expect(layout.style.getPropertyValue('--chat-batch-width')).toBe('');
    expect(disconnect).toHaveBeenCalled();
    expect(localStorage.getItem('batch-width')).toBeNull();
  });
  it('ignores invalid preferences and unavailable storage and isolates user preferences', () => {
    localStorage.setItem('batch-width', 'Infinity');
    const view = render(<Harness/>);
    expect(handle()).toHaveAttribute('aria-valuenow', '290');
    fireEvent.keyDown(handle(), {key: 'ArrowLeft'});
    view.rerender(<Harness storageKey="other-user"/>);
    expect(handle()).toHaveAttribute('aria-valuenow', '290');
    view.rerender(<Harness/>);
    expect(handle()).toHaveAttribute('aria-valuenow', '322');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
    fireEvent.keyDown(handle(), {key: 'ArrowLeft'});
    expect(handle()).toHaveAttribute('aria-valuenow', '354');
  });
  it('ignores secondary clicks and pointer gestures in the stacked layout', () => {
    render(<Harness/>);
    fireEvent.pointerDown(handle(), {button: 2, clientX: 800, pointerId: 1});
    fireEvent.pointerMove(handle(), {clientX: 700, pointerId: 1});
    expect(handle()).toHaveAttribute('aria-valuenow', '290');
    available = 760; start();
    expect(screen.getByTestId('layout')).not.toHaveAttribute('data-batch-resize');
  });
});
