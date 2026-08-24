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

  it('reads the global Codex quota without tying it to a project or tab type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      quota: { remainingPercent: 65 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.codexQuota.read();

    expect(fetchMock).toHaveBeenCalledWith('/api/codex-quota', expect.objectContaining({ headers: {} }));
  });

  it('requests project session history without filtering by runtime', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessions: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.sessions.list(undefined, 'project-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions?project_id=project-1', expect.objectContaining({ headers: {} }));
  });

  it('sends enhancement requests through the server with the active tab id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ prompt: 'Improved prompt' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.promptEnhancer.enhance({ session_id: 'tab-1', prompt: 'fix it', mode: 'standard' });

    expect(fetchMock).toHaveBeenCalledWith('/api/prompt-enhancer/enhance', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ session_id: 'tab-1', prompt: 'fix it', mode: 'standard' }),
    }));
  });

  it('detects models through the server-side LLM proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: ['gpt-4.1-mini'] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.promptEnhancer.models({ endpoint: 'https://llm.example/v1' });

    expect(fetchMock).toHaveBeenCalledWith('/api/prompt-enhancer/models', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ endpoint: 'https://llm.example/v1' }),
    }));
  });
});
