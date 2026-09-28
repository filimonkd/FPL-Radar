import { Component } from 'react';

// A render error in one page shows a message instead of blanking the app.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">
        <p className="font-medium">This page failed to display.</p>
        <p className="mt-1">{this.state.error.message}</p>
      </div>
    );
  }
}
