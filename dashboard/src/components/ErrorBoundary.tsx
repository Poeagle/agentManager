import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// React.lazy caches a rejected import promise. Clearing an error boundary is
// therefore not enough to retry a module that Vite briefly could not compile
// (or a production chunk that changed during a deployment); the page must be
// reloaded so React creates the lazy component again.
export function isDynamicModuleLoadError(error: Error): boolean {
  return /(?:failed to fetch dynamically imported module|error loading dynamically imported module|loading chunk \S+ failed|chunkloaderror)/i
    .test(`${error.name} ${error.message}`);
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.label || 'Application'}] render failed`, error, info);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const reloadRequired = isDynamicModuleLoadError(this.state.error);

    return (
      <div className="h-full min-h-48 flex items-center justify-center p-6" style={{ background: 'var(--bg-primary)' }}>
        <div className="max-w-lg rounded-lg border p-5" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--error)' }}>
            {this.props.label || 'This view'} failed to render
          </h2>
          <p className="mt-2 text-xs break-words" style={{ color: 'var(--text-secondary)' }}>
            {this.state.error.message}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="rounded px-3 py-1.5 text-xs font-medium"
              style={{ background: 'var(--accent)', color: 'white' }}
              onClick={() => {
                if (reloadRequired) {
                  window.location.reload();
                  return;
                }
                this.setState({ error: null });
              }}
            >
              {reloadRequired ? 'Reload to retry' : 'Retry view'}
            </button>
            {!reloadRequired && (
              <button
                type="button"
                className="rounded px-3 py-1.5 text-xs"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                onClick={() => window.location.reload()}
              >
                Reload app
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
