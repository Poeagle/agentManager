import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, isDynamicModuleLoadError } from '../src/components/ErrorBoundary';

function BrokenView({ error }: { error: Error }) {
  throw error;
}

describe('ErrorBoundary', () => {
  it('recognizes browser and bundler dynamic-import failures', () => {
    expect(isDynamicModuleLoadError(new TypeError(
      'Failed to fetch dynamically imported module: http://localhost/src/ProjectView.tsx',
    ))).toBe(true);
    expect(isDynamicModuleLoadError(new Error('Loading chunk 42 failed'))).toBe(true);
    expect(isDynamicModuleLoadError(new Error('ordinary render failure'))).toBe(false);
  });

  it('does not offer the ineffective view-only retry for a rejected lazy import', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary label="octoally-app">
        <BrokenView error={new TypeError('Failed to fetch dynamically imported module: /ProjectView.tsx')} />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: 'Reload to retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry view' })).not.toBeInTheDocument();
  });

  it('can retry an ordinary render error without reloading the app', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    let shouldThrow = true;

    function RecoverableView() {
      if (shouldThrow) throw new Error('ordinary render failure');
      return <div>Recovered</div>;
    }

    render(
      <ErrorBoundary label="octoally-app">
        <RecoverableView />
      </ErrorBoundary>,
    );

    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: 'Retry view' }));
    expect(screen.getByText('Recovered')).toBeInTheDocument();
  });
});
