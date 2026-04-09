import { Component, type ErrorInfo, type ReactNode } from 'react';

// ─── ImportErrorBoundary ──────────────────────────────────────────────────────

interface ImportErrorProps {
  children: ReactNode;
  /** Optional panel name shown in the fallback card (e.g. "UG Pro Importer") */
  label?: string;
}

interface ImportErrorState {
  error: Error | null;
}

/**
 * Catches render-time errors thrown by import panel components
 * (UGProImporterPanel, OemerImageImporterPanel, SvgImporterPanel).
 * Renders a plain error card instead of crashing the entire app.
 * Resets on remount — pass a `key` tied to the active file to force remount on
 * each new import attempt.
 */
export class ImportErrorBoundary extends Component<ImportErrorProps, ImportErrorState> {
  state: ImportErrorState = { error: null };

  static getDerivedStateFromError(error: Error): ImportErrorState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ImportErrorBoundary]', error.message, info.componentStack);
  }

  private reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    if (this.state.error) {
      const label = this.props.label ?? 'Import panel';
      return (
        <div className="error-boundary-card" role="alert">
          <strong>{label} failed to render</strong>
          <p>{this.state.error.message}</p>
          <button type="button" onClick={this.reset}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── SlashNotationBoundary ────────────────────────────────────────────────────

interface SlashNotationProps {
  children: ReactNode;
}

interface SlashNotationState {
  error: Error | null;
}

/**
 * Catches render-time errors from SlashNotationView.
 * Falls back to a simple message — the "Back to Chord Chart" button in the top
 * bar is always visible and lets the user recover without reloading.
 * Resets on remount — pass a `key` tied to `chartDocument` so the boundary
 * clears whenever a new file is loaded.
 */
export class SlashNotationBoundary extends Component<SlashNotationProps, SlashNotationState> {
  state: SlashNotationState = { error: null };

  static getDerivedStateFromError(error: Error): SlashNotationState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[SlashNotationBoundary]', error.message, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="error-boundary-card" role="alert">
          <strong>Slash notation could not be rendered</strong>
          <p>{this.state.error.message}</p>
          <p className="hint">Use &ldquo;Back to Chord Chart&rdquo; to continue.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
