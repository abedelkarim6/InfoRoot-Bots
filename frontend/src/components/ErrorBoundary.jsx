import { Component } from 'react';

/**
 * Catches render/runtime errors in the routed page subtree and shows the error
 * inline instead of letting it unmount the whole React root (which renders a
 * blank white screen). Reset it by changing `key` (we key it on the route path
 * in AppShell so navigating away clears the error).
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface in the console too, for good measure.
    console.error('[ErrorBoundary] page crashed:', error, info);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div style={{ padding: 24, maxWidth: 900 }}>
          <h2 style={{ marginTop: 0 }}>⚠️ This page hit an error</h2>
          <p className="text-muted">
            The rest of the app is fine — use the sidebar to navigate away. Details:
          </p>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              color: 'var(--danger)',
              background: 'var(--bg-tertiary)',
              padding: 12,
              borderRadius: 8,
              overflow: 'auto',
              fontSize: 12
            }}
          >
            {String(error?.stack || error?.message || error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
