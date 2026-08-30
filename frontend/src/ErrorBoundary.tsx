import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { message: string }

/**
 * Keeps a render-time crash from emptying the page.
 *
 * React unmounts the whole tree when a render throws, so a single bad field once turned the
 * workspace into a blank white screen that reported nothing — the user could not tell a crash
 * from a finished action. A visible failure with a way out is always better than silence.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('render failed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.message) {
      return this.props.children;
    }

    return (
      <main className="boundary">
        <h1>Something broke while displaying this page</h1>
        <p>Your data is safe: this failed while drawing the page, not while saving.</p>
        <p className="boundary-detail">{this.state.message}</p>
        <button onClick={() => window.location.reload()}>Reload the page</button>
      </main>
    );
  }
}
