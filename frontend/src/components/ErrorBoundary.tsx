/**
 * Catches a render crash so one broken screen does not take the app with it.
 *
 * React unmounts the entire tree when a render throws and nothing catches it.
 * With no boundary anywhere, that meant the whole SPA went white — not the
 * card that failed, not the page, everything. It happened for real: a contact
 * with no last name reached `last_name.localeCompare(...)` inside a useMemo,
 * and one click on Import blanked PMO 360.
 *
 * main.tsx already reasons this way about MSAL — "a failure here MUST NOT
 * block render — otherwise the whole app white-screens". That instinct simply
 * never got extended to render errors, which are far more likely: every screen
 * in this app maps API data with nullable columns straight into JSX.
 *
 * Deliberately NOT react-router's `errorElement`: that only fires for loader
 * and action errors in a data router, and this app uses a plain <Routes>. A
 * render throw would sail straight past it.
 *
 * Placement matters more than the component. Wrapped around the <Outlet>, the
 * shell survives — nav, portfolio switcher and theme all keep working, so a
 * broken page is something you navigate away from rather than a dead tab you
 * have to reload. `resetKey` (the route key) clears the error on navigation;
 * without it the boundary latches and every subsequent page renders the error
 * screen instead, which looks exactly like the crash it replaced.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Change this to clear a caught error — pass the route key so navigating
   *  away recovers. */
  resetKey?: string;
  /** Shown above the message. Defaults to something true of any screen. */
  title?: string;
}

interface State {
  error: Error | null;
  /** The resetKey the current error was caught under, so we can tell a new
   *  route from a re-render of the broken one. */
  caughtUnder?: string;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // Navigated somewhere new — drop the error so the next page gets a chance
    // to render. Compared against the key we caught under, not the previous
    // render's, so a re-render of the SAME broken route stays caught rather
    // than looping through the crash.
    if (state.error && state.caughtUnder !== undefined
        && props.resetKey !== state.caughtUnder) {
      return { error: null, caughtUnder: undefined };
    }
    if (state.error && state.caughtUnder === undefined) {
      return { caughtUnder: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The stack is the only diagnostic anyone gets — there is no client error
    // reporting in this app, so console is where a developer will look when a
    // PM says "the actions page went blank".
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private reset = () => this.setState({ error: null, caughtUnder: undefined });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="card p-6 max-w-doc mx-auto border-l-[3px] border-l-brand-red">
        <h2 className="section-title text-brand-red">
          {this.props.title ?? "This screen hit an error"}
        </h2>
        <p className="mt-2 text-sm text-brand-gray leading-relaxed">
          Nothing you did caused this and nothing has been lost — the page
          failed to draw. The rest of the app still works, so you can switch
          portfolios or move to another tab from the menu above.
        </p>
        <p className="mt-3 text-xs text-brand-lightgray font-mono break-words">
          {error.message || String(error)}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <button type="button" className="btn-primary" onClick={this.reset}>
            Try again
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => window.location.reload()}
          >
            Reload the app
          </button>
        </div>
      </div>
    );
  }
}
