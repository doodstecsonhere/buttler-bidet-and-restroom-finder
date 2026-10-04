/**
 * Buttler 2.0 — Stage 14 ownership completion: /promotions.
 *
 * The smallest operations surface that exercises the two canonical-promotion
 * endpoints that already exist and are already covered by the backend suites
 * (`scripts/stage14o-reversal.test.mjs`, Stage 14E/14D/14C): promote an approved
 * contribution, and reverse a promotion. Both go through the SAME in-app
 * authorized-fetch seam as every other protected call, so the bearer token is
 * attached by the app and never handled, shown, or stored here.
 *
 * AUTHORIZATION RULES THIS FILE OBEYS (identical to /moderation):
 *   * There is no client-side promoter check anywhere. The page renders its
 *     forms for any signed-in browser and lets the SERVER decide: the promote
 *     and reverse endpoints answer 403 for anyone not on the server-side
 *     promoter allow-list, and that 403 is the ONLY thing gating this page.
 *   * Manipulating frontend state cannot grant power: every action is a fresh
 *     authorized request; the request body carries only an optional note.
 *   * The client can never supply canonical_id, changed columns, values,
 *     snapshots, or any identity — the contribution / promotion row and the
 *     verified token are the sole authority (that is enforced in the backend).
 *
 * Like /moderation this is an operations console, not a designed public
 * dashboard, and it is not advertised anywhere in the public UI.
 */
import { useCallback, useState, type ReactNode } from "react";
import { ArrowUpRight, RotateCcw } from "lucide-react";
import {
  type ContributionResult,
  type FailureCode,
  type PromotionReceipt,
  type ReversalReceipt,
} from "@/contributions/client";
import {
  ContributionPageShell,
  FailureNotice,
  SignInGate,
  useContributionsClient,
} from "@/contributions/ui";

type Outcome<T> =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; value: T }
  | { kind: "failed"; code: FailureCode; message: string };

// The contribution / promotion id shapes the backend will accept. Checked
// client-side only for kinder, faster feedback; the server re-validates and
// remains the authority. These are plain id patterns, not permission checks.
const CONTRIBUTION_ID = /^contrib_[0-9a-f]{32}$/;
const PROMOTION_ID = /^promo_[0-9a-f]{32}$/;

export default function Promotions() {
  return (
    <ContributionPageShell
      title="Promotion console"
      subtitle="Promoter operations surface — server-authorized"
    >
      <SignInGate>
        <div className="space-y-6">
          <PromoteCard />
          <ReverseCard />
        </div>
      </SignInGate>
    </ContributionPageShell>
  );
}

function settle<T>(
  result: ContributionResult<T>,
): Outcome<T> {
  return result.ok
    ? { kind: "ok", value: result.value }
    : { kind: "failed", code: result.code, message: result.message };
}

function PromoteCard() {
  const client = useContributionsClient();
  const [contributionId, setContributionId] = useState("");
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<Outcome<PromotionReceipt>>({ kind: "idle" });

  const run = useCallback(async () => {
    const id = contributionId.trim();
    if (!CONTRIBUTION_ID.test(id)) {
      setOutcome({
        kind: "failed",
        code: "validation",
        message: "That does not look like a contribution id (contrib_ followed by 32 hex characters).",
      });
      return;
    }
    setOutcome({ kind: "running" });
    const result = await client.promote(id, note);
    setOutcome(settle(result));
  }, [client, contributionId, note]);

  return (
    <ActionCard
      heading="Promote an approved contribution"
      description="Applies one reviewed, approved contribution to the canonical listing. Only an authorized promoter succeeds; everyone else is refused by the server."
      idLabel="Contribution id"
      idValue={contributionId}
      onId={setContributionId}
      idPlaceholder="contrib_00000000000000000000000000000000"
      noteLabel="Optional promotion note"
      noteValue={note}
      onNote={setNote}
      actionLabel="Promote"
      icon={<ArrowUpRight className="w-4 h-4" />}
      outcome={outcome}
      onRun={() => void run()}
      renderSuccess={(value) => (
        <>
          <ResultLine label="Promotion id" value={value.promotionId} />
          <ResultLine label="Canonical id" value={value.canonicalId} mono />
          <ResultLine label="Changed columns" value={value.changedColumns.join(", ") || "—"} />
          <ResultLine label="Promoted at" value={value.promotedAt ?? "—"} />
          <p className="text-[11px] text-muted-foreground pt-1">
            Copy the promotion id above to reverse this change later.
          </p>
        </>
      )}
    />
  );
}

function ReverseCard() {
  const client = useContributionsClient();
  const [promotionId, setPromotionId] = useState("");
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<Outcome<ReversalReceipt>>({ kind: "idle" });

  const run = useCallback(async () => {
    const id = promotionId.trim();
    if (!PROMOTION_ID.test(id)) {
      setOutcome({
        kind: "failed",
        code: "validation",
        message: "That does not look like a promotion id (promo_ followed by 32 hex characters).",
      });
      return;
    }
    setOutcome({ kind: "running" });
    const result = await client.reverse(id, note);
    setOutcome(settle(result));
  }, [client, promotionId, note]);

  return (
    <ActionCard
      heading="Reverse a promotion"
      description="Appends a correction that restores a promotion to its guarded pre-promotion snapshot. History is never deleted; the server refuses if the row drifted or was already reversed."
      idLabel="Promotion id"
      idValue={promotionId}
      onId={setPromotionId}
      idPlaceholder="promo_00000000000000000000000000000000"
      noteLabel="Optional reversal note"
      noteValue={note}
      onNote={setNote}
      actionLabel="Reverse"
      icon={<RotateCcw className="w-4 h-4" />}
      outcome={outcome}
      onRun={() => void run()}
      renderSuccess={(value) => (
        <>
          <ResultLine label="Reversal id" value={value.reversalId} />
          <ResultLine label="Reverses" value={value.reversesPromotionId} />
          <ResultLine label="Canonical id" value={value.canonicalId} mono />
          <ResultLine
            label="Restored values"
            value={
              Object.entries(value.restoredValues)
                .map(([key, val]) => `${key}=${String(val)}`)
                .join(", ") || "—"
            }
          />
          <ResultLine label="Reversed at" value={value.reversedAt ?? "—"} />
        </>
      )}
    />
  );
}

function ActionCard<T>({
  heading,
  description,
  idLabel,
  idValue,
  onId,
  idPlaceholder,
  noteLabel,
  noteValue,
  onNote,
  actionLabel,
  icon,
  outcome,
  onRun,
  renderSuccess,
}: {
  heading: string;
  description: string;
  idLabel: string;
  idValue: string;
  onId: (value: string) => void;
  idPlaceholder: string;
  noteLabel: string;
  noteValue: string;
  onNote: (value: string) => void;
  actionLabel: string;
  icon: ReactNode;
  outcome: Outcome<T>;
  onRun: () => void;
  renderSuccess: (value: T) => ReactNode;
}) {
  const busy = outcome.kind === "running";
  const idFieldId = `${heading.replace(/\s+/g, "-").toLowerCase()}-id`;
  const noteFieldId = `${heading.replace(/\s+/g, "-").toLowerCase()}-note`;

  return (
    <section className="bg-card border border-border/50 rounded-2xl p-5 space-y-3 shadow-sm">
      <h2 className="font-display font-bold text-base text-foreground">{heading}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>

      <label htmlFor={idFieldId} className="block text-xs font-semibold text-foreground">
        {idLabel}
        <input
          id={idFieldId}
          type="text"
          value={idValue}
          onChange={(event) => onId(event.target.value)}
          placeholder={idPlaceholder}
          spellCheck={false}
          autoComplete="off"
          className="mt-1 w-full px-3 py-2 text-sm font-mono bg-white border border-border/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </label>

      <label htmlFor={noteFieldId} className="block text-xs font-semibold text-foreground">
        {noteLabel}
        <textarea
          id={noteFieldId}
          value={noteValue}
          onChange={(event) => onNote(event.target.value)}
          rows={2}
          maxLength={2000}
          className="mt-1 w-full px-3 py-2 text-sm font-normal bg-muted/40 border border-border/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </label>

      <button
        type="button"
        onClick={onRun}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-semibold text-white bg-primary hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60 transition-colors"
      >
        {icon} {busy ? "Working…" : actionLabel}
      </button>

      <div role="status" aria-live="polite" className="space-y-1 pt-1">
        {outcome.kind === "failed" && (
          <FailureNotice code={outcome.code} message={outcome.message} />
        )}
        {outcome.kind === "ok" && (
          <div className="p-3 rounded-xl bg-green-50 border border-green-200 text-green-900 text-xs space-y-0.5">
            {renderSuccess(outcome.value)}
          </div>
        )}
      </div>
    </section>
  );
}

function ResultLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <p className="break-all">
      <span className="font-semibold">{label}:</span>{" "}
      <span className={mono ? "font-mono" : undefined}>{value}</span>
    </p>
  );
}
