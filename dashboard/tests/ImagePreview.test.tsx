import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImagePreview } from '../src/components/ImagePreview';

let resize: () => void;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {}
  });
});
afterEach(() => vi.unstubAllGlobals());
function mount() {
  const download = vi.fn(), error = vi.fn();
  render(<ImagePreview url="/test.png" name="flow.png" onDownload={download} onError={error} />);
  const pane = screen.getByRole('region', { name: '图片预览画布' });
  Object.defineProperties(pane, { clientWidth: { configurable: true, value: 832 }, clientHeight: { configurable: true, value: 632 } });
  act(() => resize());
  const image = screen.getByRole('img', { name: 'flow.png' });
  Object.defineProperties(image, { naturalWidth: { value: 1600 }, naturalHeight: { value: 1200 } });
  fireEvent.load(image);
  return { image, pane, download, error };
}
describe('image preview zoom', () => {
  it('fits a large image, supports 100% and manual zoom, and refits after resizing the viewport', async () => {
    const user = userEvent.setup(), { image, pane } = mount();
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('50%');
    expect(image).toHaveStyle({ width: '800px', height: '600px' });
    await user.click(screen.getByRole('button', { name: '100%' }));
    expect(image).toHaveStyle({ width: '1600px', height: '1200px' });
    await user.click(screen.getByRole('button', { name: '放大图片' }));
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('120%');
    await user.click(screen.getByRole('button', { name: '缩小图片' }));
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('100%');
    await user.click(screen.getByRole('button', { name: '适应窗口' }));
    Object.defineProperties(pane, { clientWidth: { value: 432 }, clientHeight: { value: 332 } });
    act(() => resize());
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('25%');
  });
  it('zooms with Ctrl-wheel or double click while preserving ordinary scrolling and bounding zoom', () => {
    const { pane, image } = mount();
    const scroll = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    fireEvent(pane, scroll);
    expect(scroll.defaultPrevented).toBe(false);
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('50%');
    const zoom = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    fireEvent(pane, zoom);
    expect(zoom.defaultPrevented).toBe(true);
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('60%');
    fireEvent.doubleClick(image);
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('50%');
    fireEvent.doubleClick(image);
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('100%');
    for (let count = 0; count < 20; count++) fireEvent.keyDown(pane, { key: '+' });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('800%');
    expect(screen.getByRole('button', { name: '放大图片' })).toBeDisabled();
    for (let count = 0; count < 50; count++) fireEvent.keyDown(pane, { key: '-' });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('5%');
    expect(screen.getByRole('button', { name: '缩小图片' })).toBeDisabled();
  });
  it('keeps download and image failure handling available', async () => {
    const user = userEvent.setup(), { image, download, error } = mount();
    await user.click(screen.getByRole('button', { name: '下载原文件' }));
    expect(download).toHaveBeenCalledOnce();
    fireEvent.error(image);
    expect(error).toHaveBeenCalledOnce();
  });
});
