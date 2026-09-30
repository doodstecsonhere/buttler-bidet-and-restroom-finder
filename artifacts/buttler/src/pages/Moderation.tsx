/**
 * Buttler 2.0 — Stage 13 frontend: /moderation.
 *
 * The smallest operations surface that exercises the existing moderation API
 * locally: queue → inspect → approve / reject, with a confirmation step before
 * either decision.
 *
 * AUTHORIZATION RULES THIS FILE OBEYS:
 *   * There is no client-side moderator role, flag, or claim check anywhere.
 *     The page renders its queue for any signed-in browser and lets the
 *     SERVER decide: `GET /api/moderation/contributions` answers 403 for
 *     everyone who is not on the server-side allow-list, and that 403 is the
 *     ONLY thing that turns this page into "moderators only".
 *   * Manipulating frontend state cannot grant power: every list, open, and
 *     decision is a fresh authorized request.
 *   * Approving here records a DECISION. It does not touch canonical data —
 *     that is the separate, deliberately un-wired apply path.
 *
 * This is an operations foundation, not a designed dashboard, and it is not
 * advertised anywhere in the public UI.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, RefreshCw, ShieldAlert, XCircle } from "lucide-react";
import { useOfflineRestrooms } from "@/hooks/use-offline-restrooms";
import {
  fieldLabel,
  kindLabel,
  payloadValueLabel,
  statusLabel,
  evidenceTypeLabel,
} from "@/contributions/ui-vocabulary";
import type {
  ContributionResult,
  FailureCode,
  ModeratedContribution,
} from "@/contributions/client";
import {
  ContributionPageShell,
  FailureNotice,
  LoadingNotice,
  SignInGate,
  StatusPill,
  useContributionsClient,
} from "@/contributions/ui";

type QueueState =
  | { kind: "loading" }
  | { kind: "ready"; items: ModeratedContribution[] }
  | { kind: "failed"; failure: Extract<ContributionResult<ModeratedContribution[]>, { ok: false }> };

const STATUS_FILTERS = [
  { value: "", label: "Open (pending + reviewed)" },
  { value: "pending", label: "Pending" },
  { value: "validated", label: "Validated" },
  { value: "needs_review", label: "Needs review" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
] as const;

export default function Moderation() {
  return (
    <ContributionPageShell
      title="Moderation queue"
      subtitle="Reviewer operations surface — server-authorized"
    >
      <SignInGate>
        <ModerationWorkspace />
      </SignInGate>
    </ContributionPageShell>
  );
}

function ModerationWorkspace() {
  const client = useContributionsClient();
  const { data: catalogue } = useOfflineRestrooms();
  const [queue, setQueue] = useState<QueueState>({ kind: "loading" });
  const [filter, setFilter] = useState<string>("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<{
    code: FailureCode;
    message: string;
  } | null>(null);
  const [confirming, setConfirming] = useState<
    { item: ModeratedContribution; decision: "approve" | "reject" } | null
  >(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setQueue({ kind: "loading" });
    setOpenId(null);
    setDecisionError(null);
    const result = await client.queue(filter || undefined);
    setQueue(result.ok ? { kind: "ready", items: result.value } : { kind: "failed", failure: result });
  }, [client, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = useMemo(() => {
    if (queue.kind !== "ready" || openId === null) return null;
    return queue.items.find((item) => item.contribution_id === openId) ?? null;
  }, [queue, openId]);

  async function submitDecision(
    item: ModeratedContribution,
    decision: "approve" | "reject",
  ) {
    setBusy(true);
    setDecisionError(null);
    const result = await client.decide(item.contribution_id, decision, note);
    setBusy(false);
    setConfirming(null);
    setNote("");
    if (!result.ok) {
      setDecisionError({ code: result.code, message: result.message });
      return;
    }
    // Reflect the new status immediately, then re-pull the queue so filters
    // stay honest (an approved item leaves the default open view).
    if (queue.kind === "ready") {
      setQueue({
        kind: "ready",
        items: queue.items.map((row) =>
          row.contribution_id === item.contribution_id
            ? { ...row, status: result.value.status }
            : row,
        ),
      });
    }
    void load();
  }

  if (queue.kind === "loading") return <LoadingNotice label="Loading the queue…" />;

  if (queue.kind === "failed") {
    // 403 renders a calm "moderators only" state — decided by the SERVER.
    if (queue.failure.code === "forbidden") {
      return (
        <div className="bg-card border border-border/50 rounded-2xl p-8 text-center space-y-2">
          <ShieldAlert className="w-8 h-8 text-muted-foreground mx-auto" />
          <h2 className="font-display font-bold text-base text-foreground">
            Moderators only
          </h2>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            Buttler's server declined this request. If you believe you should be
            reviewing contributions, ask the site owner to be added to the
            reviewer list.
          </p>
        </div>
      );
    }
    return (
      <div className="space-y-3">
        <FailureNotice code={queue.failure.code} message={queue.failure.message} />
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="queue-filter" className="text-xs font-semibold text-foreground">
          Show
        </label>
        <select
          id="queue-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="flex-1 sm:flex-none px-2 py-1.5 text-sm bg-white border border-border/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          {STATUS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold text-primary bg-primary/10 hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {queue.items.length === 0 ? (
        <p className="text-sm text-muted-foreground bg-card border border-border/50 rounded-2xl p-6 text-center">
          Nothing in the queue for this filter.
        </p>
      ) : (
        <ul className="space-y-2">
          {queue.items.map((item) => (
            <li key={item.contribution_id}>
              <button
                type="button"
                onClick={() => setOpenId(item.contribution_id === openId ? null : item.contribution_id)}
                aria-expanded={item.contribution_id === openId}
                className={`w-full text-left px-4 py-3 rounded-2xl border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors ${
                  item.contribution_id === openId
                    ? "bg-primary/5 border-primary/40"
                    : "bg-card border-border/50 hover:border-primary/30"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">
                    {kindLabel(item.kind)}
                  </span>
                  <StatusPill status={item.status} />
                </div>
                <span className="block text-[11px] text-muted-foreground mt-0.5 font-mono break-all">
                  {item.contribution_id}
                </span>
              </button>

              {item.contribution_id === openId && (
                <ContributionDetail
                  item={item}
                  placeName={findPlaceName(catalogue, item.target_canonical_id)}
                  confirming={confirming?.item.contribution_id === item.contribution_id ? confirming.decision : null}
                  busy={busy}
                  note={note}
                  onNote={setNote}
                  onStartConfirm={(decision) => setConfirming({ item, decision })}
                  onCancelConfirm={() => {
                    setConfirming(null);
                    setNote("");
                  }}
                  onConfirm={() => confirming && void submitDecision(confirming.item, confirming.decision)}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {decisionError && (
        <FailureNotice code={decisionError.code} message={decisionError.message} />
      )}
    </div>
  );
}

function findPlaceName(
  catalogue: { id: string | number; name: string }[] | null,
  targetId: string | null,
): string | null {
  if (!catalogue || targetId === null) return null;
  return catalogue.find((place) => String(place.id) === targetId)?.name ?? null;
}

function ContributionDetail({
  item,
  placeName,
  confirming,
  busy,
  note,
  onNote,
  onStartConfirm,
  onCancelConfirm,
  onConfirm,
}: {
  item: ModeratedContribution;
  placeName: string | null;
  confirming: "approve" | "reject" | null;
  busy: boolean;
  note: string;
  onNote: (value: string) => void;
  onStartConfirm: (decision: "approve" | "reject") => void;
  onCancelConfirm: () => void;
  onConfirm: () => void;
}) {
  const decided = item.status === "approved" || item.status === "rejected";
  const evidence = Array.isArray(item.evidence) ? (item.evidence as Record<string, unknown>[]) : [];

  return (
    <div className="mt-1 mb-2 mx-2 p-4 rounded-2xl bg-muted/40 border border-border/40 space-y-3 text-sm">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <p>
          <span className="font-semibold text-foreground">Target:</span>{" "}
          {item.kind === "new_location"
            ? "new place (no listing)"
            : placeName ?? item.target_canonical_id ?? "—"}
        </p>
        <p>
          <span className="font-semibold text-foreground">Submitted:</span>{" "}
          {item.submitted_at ?? "—"}
        </p>
        <p>
          <span className="font-semibold text-foreground">Validation:</span>{" "}
          {item.validation_status ?? "—"}
        </p>
        <p>
          <span className="font-semibold text-foreground">Status:</span>{" "}
          {statusLabel(item.status)}
        </p>
      </div>

      <div>
        <h4 className="text-xs font-bold text-foreground uppercase tracking-wide mb-1">
          Proposed changes
        </h4>
        <ul className="space-y-0.5">
          {Object.entries(item.payload ?? {}).map(([key, value]) => (
            <li key={key}>
              <span className="font-semibold">{fieldLabel(key)}:</span>{" "}
              {payloadValueLabel(key, value)}
            </li>
          ))}
        </ul>
      </div>

      {item.notes && (
        <p>
          <span className="font-semibold">Contributor notes:</span> {item.notes}
        </p>
      )}

      {evidence.length > 0 && (
        <div>
          <h4 className="text-xs font-bold text-foreground uppercase tracking-wide mb-1">
            Evidence
          </h4>
          <ul className="space-y-1">
            {evidence.map((entry, index) => (
              <li key={index} className="text-xs bg-white/70 border border-border/30 rounded-lg px-2 py-1">
                <span className="font-semibold">{evidenceTypeLabel(entry.type)}</span>
                {typeof entry.detail === "string" && <> — {entry.detail}</>}
                {typeof entry.source_url === "string" && (
                  <> — <span className="font-mono break-all">{entry.source_url}</span></>
                )}
                {typeof entry.observed_at === "string" && <> ({entry.observed_at})</>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {item.moderation_note && (
        <p className="text-xs text-muted-foreground">
          <span className="font-semibold">Moderation note:</span>{" "}
          {item.moderation_note}
          {item.decided_at ? ` · ${item.decided_at}` : ""}
        </p>
      )}

      {decided ? (
        <p className="text-xs text-muted-foreground">
          This contribution already holds a final decision.
        </p>
      ) : confirming ? (
        <div
          className="p-3 rounded-xl bg-white border border-primary/30 space-y-2"
          role="group"
          aria-label="Confirm moderation decision"
        >
          <p className="text-sm font-semibold text-foreground">
            {confirming === "approve"
              ? "Approve this contribution?"
              : "Reject this contribution?"}{" "}
            <span className="font-normal text-muted-foreground">
              Approving records a decision — it never edits the listing by
              itself.
            </span>
          </p>
          <label className="block text-xs font-semibold text-foreground">
            Optional note for the record
            <textarea
              value={note}
              onChange={(event) => onNote(event.target.value)}
              rows={2}
              maxLength={2000}
              className="mt-1 w-full px-2 py-1.5 text-sm font-normal bg-muted/40 border border-border/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onConfirm}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60 ${
                confirming === "approve" ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700"
              }`}
            >
              {busy ? "Sending…" : confirming === "approve" ? "Yes, approve" : "Yes, reject"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onCancelConfirm}
              className="px-3 py-1.5 rounded-full text-xs font-semibold text-foreground bg-muted hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onStartConfirm("approve")}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold text-white bg-green-600 hover:bg-green-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Approve
          </button>
          <button
            type="button"
            onClick={() => onStartConfirm("reject")}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold text-white bg-red-600 hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
          >
            <XCircle className="w-3.5 h-3.5" /> Reject
          </button>
        </div>
      )}
    </div>
  );
}
