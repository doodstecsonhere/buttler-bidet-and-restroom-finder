/**
 * Buttler 2.0 — Stage 13 frontend: the sign-in control.
 *
 * One small surface, placed exactly where the disabled "Log in — coming soon"
 * placeholders already lived, so nothing else about Buttler's layout changes.
 *
 * It renders state, never permission: the most it ever claims is "this browser
 * holds a verified Auth0 session for <name>". Whether that person may
 * contribute or moderate is answered by the server on each request
 * (`functions/_lib/identity.ts`), and a 401/403 from there is the only thing a
 * future moderator UI may act on.
 */
import { useButtlerAuth } from "@/auth/AuthProvider";
import type { AuthState } from "@/auth/state";

/** `sm` matches the mobile overlay header, `md` the desktop sidebar header. */
type ControlSize = "sm" | "md";

const SIZE = {
  sm: { text: "text-[10px]", pad: "px-2 py-1", label: "text-[10px]" },
  md: { text: "text-xs", pad: "px-3 py-1.5", label: "text-xs" },
} as const;

// Reused across every state so a disabled placeholder, a call to action, and a
// sign-out affordance all look like the pill Buttler already used here.
function pill(size: ControlSize, extra = ""): string {
  const scale = SIZE[size];
  return [
    "font-semibold rounded-full whitespace-nowrap transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
    scale.text,
    scale.pad,
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}

const NEUTRAL = "text-sky-700 bg-sky-100";
const ACTION =
  "text-white bg-primary hover:bg-primary/90 border border-primary/30";
const DANGER = "text-sky-700 bg-sky-100 hover:bg-sky-200 border border-sky-200";
const MUTED = "text-sky-700 bg-sky-100 opacity-75";

export function AuthControl({ size = "md" }: { size?: ControlSize }) {
  const { state, login, logout } = useButtlerAuth();

  // A visually-hidden announcement for the state changes the user did not
  // cause (silent renewal succeeded, startup failed). Buttons announce
  // themselves when activated, so this stays short. The other instance of this
  // component is `display:none` at that breakpoint, so it cannot double-announce.
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement(state)}
      </p>
      <AuthControlBody state={state} size={size} onLogin={login} onLogout={logout} />
    </div>
  );
}

function AuthControlBody({
  state,
  size,
  onLogin,
  onLogout,
}: {
  state: AuthState;
  size: ControlSize;
  onLogin: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const scale = SIZE[size];

  switch (state.status) {
    // No public Auth0 configuration: keep the exact placeholder Buttler ships
    // today. Nothing about the read-only app changes.
    case "unconfigured":
      return (
        <button
          type="button"
          disabled
          aria-disabled="true"
          title="Sign-in is not available on this deployment yet."
          className={`${pill(size, MUTED)} cursor-not-allowed`}
        >
          Log in — coming soon
        </button>
      );

    // Startup is still resolving. Announced, never blocking: the rest of the
    // app is interactive underneath.
    case "loading":
      return (
        <button
          type="button"
          disabled
          aria-disabled="true"
          aria-busy="true"
          className={`${pill(size, MUTED)} cursor-default`}
        >
          Checking sign-in…
        </button>
      );

    case "anonymous":
      return (
        <button
          type="button"
          onClick={() => void onLogin()}
          className={pill(size, ACTION)}
        >
          Log in
        </button>
      );

    case "error":
      // The reason is available to a screen reader and a tooltip, but the
      // visible label stays an action rather than a wall of provider jargon.
      return (
        <button
          type="button"
          onClick={() => void onLogin()}
          title={state.error ?? "Sign-in did not complete."}
          className={pill(size, DANGER)}
        >
          Try sign-in again
        </button>
      );

    case "authenticated": {
      const name = state.profile?.displayName ?? "Signed in";
      return (
        <>
          <span
            className={`${scale.label} font-semibold text-sky-800 bg-sky-50 border border-sky-100 rounded-full px-2 py-1 max-w-[9rem] md:max-w-[14rem] truncate`}
            title={`Signed in with Buttler as ${name}`}
          >
            <span className="sr-only">Signed in as </span>
            <span aria-hidden="true">{name}</span>
          </span>
          <button
            type="button"
            onClick={() => void onLogout()}
            className={pill(size, NEUTRAL)}
          >
            Log out
          </button>
        </>
      );
    }
  }
}

function announcement(state: AuthState): string {
  switch (state.status) {
    case "loading":
      return "Checking sign-in.";
    case "unconfigured":
      return "";
    case "anonymous":
      return "Not signed in.";
    case "authenticated":
      return `Signed in as ${state.profile?.displayName ?? "a Buttler contributor"}.`;
    case "error":
      return `Sign-in problem: ${state.error ?? "unknown"}. Browsing still works.`;
  }
}
