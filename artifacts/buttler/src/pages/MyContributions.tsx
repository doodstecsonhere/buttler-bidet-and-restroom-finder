/**
 * Buttler 2.0 — Stage 13 frontend: /my-contributions.
 *
 * The contributor's own history via `GET /api/me/contributions`, which the
 * backend already projects down to the BASE public shape — reviewer notes and
 * decision metadata are simply not in the response, so this page cannot leak
 * them. Shows kind (friendly label), target place name when the catalogue
 * still knows it, status, submitted time, and a short summary of the payload.
 *
 * States handled explicitly: sign-in gate, loading, empty history, 401 (token
 * rejected), 503 (contributions not open on this deployment — the honest,
 * fail-closed answer), and generic failures with a retry.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { Inbox, RefreshCw } from "lucide-react";
import { useOfflineRestrooms } from "@/hooks/use-offline-restrooms";
import type { PublicContribution } from "@/contributions/client";
import type { ContributionResult } from "@/contributions/client";
import { fieldLabel, kindLabel, payloadValueLabel } from "@/contributions/ui-vocabulary";
import {
  ContributionPageShell,
  FailureNotice,
  LoadingNotice,
  SignInGate,
  StatusPill,
  useContributionsClient,
} from "@/contributions/ui";

type ViewState =
  | { kind: "loading" }
  | { kind: "loaded"; items: PublicContribution[] }
  | { kind: "failed"; failure: Extract<ContributionResult<PublicContribution[]>, { ok: false }> };

export default function MyContributions() {
  return (
    <ContributionPageShell
      title="My contributions"
      subtitle="Everything you have reported to Buttler"
    >
      <SignInGate>
        <HistoryList />
      </SignInGate>
    </ContributionPageShell>
  );
}

function HistoryList() {
  const client = useContributionsClient();
  const { data: catalogue } = useOfflineRestrooms();
  const [view, setView] = useState<ViewState>({ kind: "loading" });

  const load = useCallback(async () => {
    setView({ kind: "loading" });
    const result = await client.listMine();
    setView(result.ok ? { kind: "loaded", items: result.value } : { kind: "failed", failure: result });
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (view.kind === "loading") return <LoadingNotice label="Fetching your history…" />;

  if (view.kind === "failed") {
    return (
      <div className="space-y-3">
        <FailureNotice code={view.failure.code} message={view.failure.message} />
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-semibold text-primary bg-primary/10 hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Try again
        </button>
      </div>
    );
  }

  if (view.items.length === 0) {
    return (
      <div className="bg-card border border-border/50 rounded-2xl p-8 text-center space-y-3">
        <Inbox className="w-8 h-8 text-muted-foreground/60 mx-auto" />
        <h2 className="font-display font-bold text-base text-foreground">
          No contributions yet
        </h2>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
          When you report a problem, a fee change, or a new place, it will show
          up here with its review status.
        </p>
        <Link
          href="/contribute"
          className="inline-block px-4 py-2 rounded-full text-sm font-semibold text-white bg-primary hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
        >
          Make your first report
        </Link>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {view.items.map((item) => (
        <HistoryItem key={item.contribution_id} item={item} catalogue={catalogue ?? []} />
      ))}
    </ul>
  );
}

function HistoryItem({
  item,
  catalogue,
}: {
  item: PublicContribution;
  catalogue: { id: string | number; name: string }[];
}) {
  const place =
    item.target_canonical_id !== null
      ? catalogue.find((entry) => String(entry.id) === item.target_canonical_id)
      : undefined;
  const summary = summarisePayload(item.payload);

  return (
    <li className="bg-card border border-border/50 rounded-2xl p-4 space-y-1.5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display font-bold text-sm text-foreground">
          {kindLabel(item.kind)}
        </h3>
        <StatusPill status={item.status} />
      </div>
      <p className="text-xs text-muted-foreground">
        {item.kind === "new_location"
          ? "A brand-new place (not attached to a listing)"
          : place
            ? `About: ${place.name}`
            : "About a place no longer in the list"}
      </p>
      {summary && <p className="text-sm text-foreground/90">{summary}</p>}
      {item.notes && (
        <p className="text-xs text-muted-foreground line-clamp-2">“{item.notes}”</p>
      )}
      <p className="text-[11px] text-muted-foreground">
        Submitted {formatSubmittedAt(item.submitted_at)}
      </p>
    </li>
  );
}

/** One-line, human summary of the allow-listed payload fields. */
function summarisePayload(payload: Record<string, unknown> | null): string {
  if (!payload) return "";
  return Object.entries(payload)
    .map(([key, value]) => `${fieldLabel(key)}: ${payloadValueLabel(key, value)}`)
    .join(" · ");
}

function formatSubmittedAt(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
