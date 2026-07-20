import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from '../src/components/AuthGate';
import { api } from '../src/lib/api';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      auth: {
        ...actual.api.auth,
        status: vi.fn(),
        setup: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
      },
    },
  };
});

beforeEach(() => vi.clearAllMocks());

describe('AuthGate', () => {
  it('renders authenticated content with the resolved user', async () => {
    vi.mocked(api.auth.status).mockResolvedValue({
      needsSetup: false,
      authenticated: true,
      user: { id: 'u1', username: 'alice', display_name: 'Alice', role: 'admin' },
    });
    render(<AuthGate>{(user) => <div>Welcome {user.display_name}</div>}</AuthGate>);
    expect(await screen.findByText('Welcome Alice')).toBeInTheDocument();
  });

  it('shows first-run setup and validates required credentials', async () => {
    vi.mocked(api.auth.status).mockResolvedValue({ needsSetup: true, authenticated: false, user: null });
    render(<AuthGate>{() => <div>private</div>}</AuthGate>);
    expect(await screen.findByRole('heading', { name: '创建管理员账户' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建并进入' })).toBeDisabled();
  });

  it('submits login credentials and displays API failures', async () => {
    vi.mocked(api.auth.status).mockResolvedValue({ needsSetup: false, authenticated: false, user: null });
    vi.mocked(api.auth.login).mockRejectedValue(new Error('Invalid username or password'));
    const user = userEvent.setup();
    render(<AuthGate>{() => <div>private</div>}</AuthGate>);

    await user.type(await screen.findByLabelText('用户名'), 'alice');
    await user.type(screen.getByLabelText('密码'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(api.auth.login).toHaveBeenCalledWith({ username: 'alice', password: 'wrong-password' }));
    expect(await screen.findByText('Invalid username or password')).toBeInTheDocument();
  });
});
