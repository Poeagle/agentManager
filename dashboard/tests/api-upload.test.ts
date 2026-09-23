import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, scopeProjectFiles } from '../src/lib/api';

function mockRequest() {
  const request = {
    open: vi.fn(), setRequestHeader: vi.fn(), send: vi.fn(),
    upload: { onprogress: (_event: { lengthComputable: boolean; loaded: number; total: number }) => {} },
    responseType: '', withCredentials: false, status: 200,
    response: { ok: true } as unknown,
    onload: () => {}, onerror: () => {}, onabort: () => {},
  };
  vi.stubGlobal('XMLHttpRequest', vi.fn(function () { return request; }));
  return request;
}

afterEach(() => vi.unstubAllGlobals());

describe('file upload API client', () => {
  it('retains project scope for binary uploads', async () => {
    const xhr = mockRequest();
    const result = scopeProjectFiles(api.files, 'project-1').upload('/project', new File(['a'], 'a.txt'));
    expect(xhr.open).toHaveBeenCalledWith('POST', '/api/files/upload?path=%2Fproject&filename=a.txt&project_id=project-1');
    xhr.onload();
    await result;
  });
  it('sends raw file bytes, encodes the destination, and reports upload progress', async () => {
    const xhr = mockRequest();
    const file = new File(['hello'], '测试 & file.txt');
    const progress = vi.fn();
    const result = api.files.upload('/project/a b', file, progress);
    expect(xhr.open).toHaveBeenCalledWith('POST', `/api/files/upload?path=${encodeURIComponent('/project/a b')}&filename=${encodeURIComponent(file.name)}`);
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
    expect(xhr.send).toHaveBeenCalledWith(file);
    expect(xhr.withCredentials).toBe(true);
    xhr.upload.onprogress({ lengthComputable: true, loaded: 5, total: 10 });
    expect(progress).toHaveBeenCalledWith(0.5);
    xhr.onload();
    await expect(result).resolves.toEqual({ ok: true });
  });

  it('preserves JSON transport for existing terminal attachments', async () => {
    const xhr = mockRequest();
    const result = api.sessions.pasteFile('session-1', 'data:text/plain;base64,YQ==', 'a.txt');
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(xhr.send).toHaveBeenCalledWith(JSON.stringify({ dataUrl: 'data:text/plain;base64,YQ==', filename: 'a.txt' }));
    xhr.onload();
    await result;
  });

  it('surfaces server errors without reporting a successful upload', async () => {
    const xhr = mockRequest();
    const result = api.files.upload('/project', new File(['a'], 'a.txt'));
    xhr.status = 409;
    xhr.response = { error: '同名文件已存在' };
    xhr.onload();
    await expect(result).rejects.toThrow('同名文件已存在');
  });
});
