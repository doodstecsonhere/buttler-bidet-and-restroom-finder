/**
 * Buttler 2.0 — Stage 13 frontend: shared pieces for the contribution pages.
 *
 * Small, deliberately boring building blocks so the three routes
 * (/contribute, /my-contributions, /moderation) look and behave like the rest
 * of Buttler instead of a bolted-on admin area:
 *
 *   * `ContributionPageShell` — the header + scrollable card layout.
 *   * `SignInGate` — renders children only for a signed-in browser, and a
 *     clear sign-in (or "not open yet") state for everyone else. It renders
 *     AUTHENTICATION state only — never a permission. Whether this person may
 *     moderate is answered by the server on each request.
 *   * `useContributionsClient` — wires the pure API client to the app's one
 *     authorized-fetch seam.
 */
import { useMemo, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useButtlerAuth } from "@/auth/AuthProvider";
import { AuthControl } from "@/auth/AuthControl";
import {
  createContributionsClient,
  type ContributionsClient,
} from "@/contributions/client";
import type { FailureCode } from "@/contributions/client";
import { statusLabel } from "@/contributions/ui-vocabulary";

export function ContributionPageShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col min-h-[100dvh] w-full bg-background">
      <header className="sticky top-0 z-10 bg-white/85 backdrop-blur-md border-b border-border/60 px-4 py-3 flex items-center gap-3">
        <Link
          href="/"
          aria-label="Back to the restroom map"
          className="flex items-center justify-center w-9 h-9 rounded-xl bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="font-display font-bold text-base text-foreground leading-tight truncate">
            {title}
          </h1>
          {subtitle && (
            <p className="text-[11px] text-muted-foreground truncate">{subtitle}</p>
          )}
        </div>
        <AuthControl size="sm" />
      </header>
      <main className="flex-1 w-full max-w-2xl mx-auto px-4 py-4 space-y-4">
        {children}
      </main>
    </div>
  );
}

/**
 * Gate on sign-in STATE (not permission). The contribution and history views
 * are useless without an identity, so they ask for it up front instead of
 * showing a form that can only fail.
 */
export function SignInGate({ children }: { children: ReactNode }) {
  const { state, login } = useButtlerAuth();

  if (state.status === "authenticated") return <>{children}</>;

  return (
    <div className="bg-card border border-border/50 rounded-2xl p-6 text-center space-y-3 shadow-sm">
      {state.status === "loading" && (
        <>
          <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto" />
          <p className="text-sm text-muted-foreground">Checking your sign-in…</p>
        </>
      )}
      {state.status === "unconfigured" && (
        <>
          <h2 className="font-display font-bold text-base text-foreground">
            Contributions aren't open yet
          </h2>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            This deployment of Buttler doesn't offer sign-in yet, so community
            reports are closed. Browsing restrooms and bidets still works.
          </p>
        </>
      )}
      {(state.status === "anonymous" || state.status === "error") && (
        <>
          <h2 className="font-display font-bold text-base text-foreground">
            Sign in to contribute
          </h2>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            Buttler keeps every report traceable to a real person so moderators
            can trust the queue. Sign in with Auth0 to submit or review
            contributions.
          </p>
          <button
            type="button"
            onClick={() => void login()}
            className="px-4 py-2 rounded-full text-sm font-semibold text-white bg-primary hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
          >
            {state.status === "error" ? "Try sign-in again" : "Log in"}
          </button>
        </>
      )}
    </div>
  );
}

export function useContributionsClient(): ContributionsClient {
  const { authorizedFetch } = useButtlerAuth();
  return useMemo(
    () => createContributionsClient({ request: authorizedFetch }),
    [authorizedFetch],
  );
}

/** Compact, friendly copy for each failure family the client can report. */
export function failureHeadline(code: FailureCode): string {
  switch (code) {
    case "auth_required":
      return "Sign-in needed";
    case "forbidden":
      return "Moderators only";
    case "not_open":
      return "Not open yet";
    case "duplicate":
      return "Already reported";
    case "rate_limited":
      return "Too many open reports";
    case "offline":
      return "You're offline";
    case "too_large":
      return "Too long";
    case "not_found":
      return "Not found";
    case "validation":
      return "Check the form";
    case "server":
      return "Service problem";
  }
}

export function FailureNotice({
  code,
  message,
}: {
  code: FailureCode;
  message: string;
}) {
  return (
    <div
      role="alert"
      className="p-3 rounded-2xl border bg-orange-50 border-orange-200 text-orange-800 text-sm space-y-0.5"
    >
      <p className="font-semibold">{failureHeadline(code)}</p>
      <p>{message}</p>
    </div>
  );
}

export function LoadingNotice({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 space-y-3 text-muted-foreground">
      <Loader2 className="w-6 h-6 animate-spin text-primary" />
      <p className="text-sm font-medium animate-pulse">{label}</p>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  validated: "bg-sky-100 text-sky-800",
  needs_review: "bg-orange-100 text-orange-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  withdrawn: "bg-slate-100 text-slate-700",
  superseded: "bg-slate-100 text-slate-700",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${
        STATUS_TONE[status] ?? "bg-slate-100 text-slate-700"
      }`}
    >
      {statusLabel(status)}
    </span>
  );
}
