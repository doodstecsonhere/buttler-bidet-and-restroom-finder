/**
 * Buttler 2.0 — Stage 13 frontend: development-only proof that the bearer token
 * actually reaches the protected Pages Functions.
 *
 * Rendered only when `import.meta.env.DEV` is true, and Vite statically folds
 * that flag to `false` in a production build, so this component and its module
 * never ship to `buttler.pages.dev`.
 *
 * It performs ONE read-only call, `GET /api/me/contributions`, which already
 * exists and is already covered by `scripts/stage13-contributions.test.mjs`. It
 * deliberately does not submit anything: no contribution is created, no
 * canonical row is touched, and the response is shown as a status code plus a
 * short excerpt rather than being rendered as data.
 *
 * What each answer proves, in the order the backend gates:
 *   503  auth is not wired server-side (no AUTH0_* env) or no DB binding
 *   401  the bearer token was sent but rejected (wrong audience/issuer/expired)
 *   200  the token verified; the list is empty until contributions are enabled
 */
import { useState } from "react";
import { useButtlerAuth } from "@/auth/AuthProvider";
import { AuthRequiredError } from "@/auth/authorized-fetch";

const PROTECTED_PATH = "/api/me/contributions";

type Outcome =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "response"; status: number; excerpt: string }
  | { kind: "error"; message: string };

export function DevAuthProbe() {
  const { state, authorizedFetch } = useButtlerAuth();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

  async function call() {
    setOutcome({ kind: "running" });
    try {
      const response = await authorizedFetch(PROTECTED_PATH, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      const text = await response.text();
      setOutcome({
        kind: "response",
        status: response.status,
        excerpt: text.slice(0, 160),
      });
    } catch (cause) {
      setOutcome({
        kind: "error",
        message:
          cause instanceof AuthRequiredError
            ? cause.message
            : `request failed: ${String(cause)}`,
      });
    }
  }

  return (
    <details className="text-[10px] leading-snug text-muted-foreground max-w-[22rem]">
      <summary className="cursor-pointer select-none font-semibold">
        dev: protected API check
      </summary>
      <p>
        Read-only. Calls <code>GET {PROTECTED_PATH}</code> with the Auth0 bearer
        token. Submits nothing; canonical data is untouched. Auth0 status:{" "}
        <strong>{state.status}</strong>.
      </p>
      <button
        type="button"
        onClick={() => void call()}
        disabled={outcome.kind === "running"}
        className="mt-1 px-2 py-1 rounded-md border border-border/60 bg-muted/60 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
      >
        {outcome.kind === "running" ? "calling…" : "call protected endpoint"}
      </button>
      <p className="mt-1 break-words" role="status" aria-live="polite">
        {describe(outcome)}
      </p>
    </details>
  );
}

function describe(outcome: Outcome): string {
  switch (outcome.kind) {
    case "idle":
      return "";
    case "running":
      return "waiting for the response…";
    case "response":
      return `HTTP ${outcome.status} — ${outcome.excerpt || "(empty body)"}`;
    case "error":
      return outcome.message;
  }
}
