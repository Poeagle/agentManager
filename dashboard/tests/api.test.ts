import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

describe('dashboard API client', () => {
  it('marks automatic resume requests for server-side circuit breaking', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      session: { id: 'session-1' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.sessions.resume('session-1', true);

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/resume', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ automatic: true }),
    }));
  });

  it('encodes durable user-state keys and payloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const value = { activeTerminalId: 'session-1' };

    await api.userState.set('project:abc', value);

    expect(fetchMock).toHaveBeenCalledWith('/api/user-state/project%3Aabc', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ value }),
    }));
  });

  it('surfaces the server error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'No native conversation' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })));
    await expect(api.sessions.resume('missing')).rejects.toThrow('No native conversation');
  });
});
