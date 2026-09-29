/**
 * Buttler 2.0 — Stage 13 frontend: /contribute.
 *
 * ONE reusable flow for all eight contribution kinds, per the Stage 12/13
 * architecture: the kind decides which allow-listed fields appear, the client
 * builds a contract-shaped request, and the server decides everything else.
 *
 * Deep links: `/contribute?target=<canonical_id>` (from a restroom card) opens
 * the flow pre-targeted with that place, and the target is shown read-only —
 * the link is a shortcut, not a trust boundary; the backend re-validates the
 * id against `canonical_locations` on every submit.
 *
 * This page never writes canonical data: a successful submission is a
 * PENDING row in the moderation queue, and the success screen says so.
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "wouter";
import { CheckCircle2, Plus, X } from "lucide-react";
import type { ContributionKind } from "../../../../lib/contributions/contract";
import { useOfflineRestrooms } from "@/hooks/use-offline-restrooms";
import {
  isCanonicalTargetId,
  type ContributionDraft,
  type ContributionResult,
  type EvidenceDraft,
  type SubmissionReceipt,
} from "@/contributions/client";
import {
  EVIDENCE_TYPES,
  FIELDS_BY_KIND,
  KIND_OPTIONS,
  fieldOptionsFor,
  kindRequiresTarget,
} from "@/contributions/ui-vocabulary";
import type { FieldSpec } from "@/contributions/ui-vocabulary";
import {
  FailureNotice,
  SignInGate,
  StatusPill,
  ContributionPageShell,
  useContributionsClient,
} from "@/contributions/ui";

const MAX_EVIDENCE_ROWS = 5;
const NOTES_MAX = 2000;

/** Raw form values, keyed by backend field name, before payload coercion. */
type FieldValues = Record<string, string | boolean>;

const emptyValues = (): FieldValues => ({});
const emptyEvidence = (): EvidenceDraft => ({
  type: "field_observation",
  detail: "",
  observed_at: "",
  source_url: "",
});

export default function Contribute() {
  const [params] = useSearchParams();
  const targetParam = params.get("target");
  const linkedTarget = isCanonicalTargetId(targetParam) ? targetParam : null;

  const { data: catalogue } = useOfflineRestrooms();
  const linkedPlace = useMemo(
    () =>
      linkedTarget
        ? catalogue?.find((place) => String(place.id) === linkedTarget) ?? null
        : null,
    [linkedTarget, catalogue],
  );

  // From a card deep link, "new location" would contradict the target, so the
  // picker only offers the seven existing-place kinds in that case.
  const kindChoices = useMemo(
    () => (linkedTarget ? KIND_OPTIONS.filter((o) => o.kind !== "new_location") : KIND_OPTIONS),
    [linkedTarget],
  );

  return (
    <ContributionPageShell
      title="Contribute"
      subtitle="Help Buttler's guardians keep the map honest"
    >
      <SignInGate>
        <ContributionForm
          kindChoices={kindChoices}
          fixedTargetId={linkedTarget}
          fixedTargetName={linkedPlace?.name ?? null}
          catalogue={catalogue ?? []}
        />
      </SignInGate>
    </ContributionPageShell>
  );
}

type CataloguePlace = { id: string | number; name: string; address: string | null };

function ContributionForm({
  kindChoices,
  fixedTargetId,
  fixedTargetName,
  catalogue,
}: {
  kindChoices: typeof KIND_OPTIONS;
  fixedTargetId: string | null;
  fixedTargetName: string | null;
  catalogue: CataloguePlace[];
}) {
  const client = useContributionsClient();

  const [kind, setKind] = useState<ContributionKind>(kindChoices[0].kind);
  const [values, setValues] = useState<FieldValues>(emptyValues());
  const [targetId, setTargetId] = useState<string | null>(fixedTargetId);
  const [targetName, setTargetName] = useState<string | null>(fixedTargetName);
  const [notes, setNotes] = useState("");
  const [evidence, setEvidence] = useState<EvidenceDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<
    | { kind: "idle" }
    | { kind: "success"; receipt: SubmissionReceipt }
    | { kind: "failure"; failure: Extract<ContributionResult<SubmissionReceipt>, { ok: false }> }
  >({ kind: "idle" });

  const specs = FIELDS_BY_KIND[kind];
  const targetResolved = kind === "new_location" ? true : Boolean(fixedTargetId || targetId);

  function chooseKind(next: ContributionKind) {
    setKind(next);
    setValues(emptyValues());
    setOutcome({ kind: "idle" });
  }

  function buildPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const spec of specs) {
      const raw = values[spec.key];
      if (raw === undefined || raw === "") continue;
      if (spec.control === "checkbox") {
        if (raw === true) payload[spec.key] = true;
      } else if (spec.control === "number") {
        const parsed = Number(raw);
        payload[spec.key] = Number.isFinite(parsed) ? parsed : String(raw);
      } else {
        payload[spec.key] = String(raw).trim();
      }
    }
    return payload;
  }

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    const draft: ContributionDraft = {
      kind,
      targetCanonicalId: kind === "new_location" ? null : fixedTargetId ?? targetId,
      payload: buildPayload(),
      notes: notes.trim(),
      evidence,
    };
    const result = await client.submit(draft);
    setSubmitting(false);
    if (result.ok) {
      setOutcome({ kind: "success", receipt: result.value });
      window.scrollTo({ top: 0 });
    } else {
      setOutcome({ kind: "failure", failure: result });
    }
  }

  function resetForAnother() {
    setOutcome({ kind: "idle" });
    setValues(emptyValues());
    setNotes("");
    setEvidence([]);
  }

  if (outcome.kind === "success") {
    return <SuccessPanel receipt={outcome.receipt} onAnother={resetForAnother} />;
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {/* 1. What kind of contribution */}
      <fieldset className="bg-card border border-border/50 rounded-2xl p-4 space-y-2">
        <legend className="font-display font-bold text-sm text-foreground px-1">
          What do you want to report?
        </legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {kindChoices.map((choice) => (
            <button
              key={choice.kind}
              type="button"
              onClick={() => chooseKind(choice.kind)}
              aria-pressed={kind === choice.kind}
              className={`text-left px-3 py-2 rounded-xl border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors ${
                kind === choice.kind
                  ? "bg-primary/10 border-primary/50 font-semibold text-foreground"
                  : "bg-muted/40 border-border/50 text-muted-foreground hover:border-primary/30"
              }`}
            >
              {choice.label}
              <span className="block text-[11px] font-normal opacity-80">
                {choice.description}
              </span>
            </button>
          ))}
        </div>
      </fieldset>

      {/* 2. Which place */}
      {kind === "new_location" ? (
        <p className="text-xs text-muted-foreground px-1">
          A brand-new place stands on its own — no existing listing needed.
        </p>
      ) : fixedTargetId ? (
        <div className="bg-sky-50 border border-sky-200 rounded-2xl p-3 text-sm text-sky-900">
          <span className="font-semibold">About:</span>{" "}
          {targetName ?? "this place"}
          <span className="block text-[11px] text-sky-700 mt-0.5 break-all">
            {fixedTargetId}
          </span>
        </div>
      ) : (
        <TargetPicker
          catalogue={catalogue}
          pickedId={targetId}
          pickedName={targetName}
          onPick={(id, name) => {
            setTargetId(id);
            setTargetName(name);
          }}
          onClear={() => {
            setTargetId(null);
            setTargetName(null);
          }}
        />
      )}

      {/* 3. Kind-specific fields */}
      <fieldset className="bg-card border border-border/50 rounded-2xl p-4 space-y-3">
        <legend className="font-display font-bold text-sm text-foreground px-1">
          Your report
        </legend>
        {specs.map((spec) => (
          <FieldInput
            key={`${kind}:${spec.key}`}
            spec={spec}
            value={values[spec.key]}
            onChange={(next) =>
              setValues((prev) => ({ ...prev, [spec.key]: next }))
            }
          />
        ))}
        {kindRequiresTarget(kind) && !targetResolved && (
          <p className="text-xs text-orange-700">
            Pick which place this is about above.
          </p>
        )}

        <div>
          <label
            htmlFor="contribute-notes"
            className="block text-xs font-semibold text-foreground mb-1"
          >
            Anything else the reviewers should know?{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <textarea
            id="contribute-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value.slice(0, NOTES_MAX + 200))}
            rows={3}
            maxLength={NOTES_MAX}
            className="w-full px-3 py-2 text-sm bg-muted/60 border border-border/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <p className="text-[11px] text-muted-foreground mt-0.5 text-right">
            {notes.length}/{NOTES_MAX}
          </p>
        </div>
      </fieldset>

      {/* 4. Evidence */}
      <EvidenceEditor
        rows={evidence}
        onChange={(rows) => {
          if (rows.length <= MAX_EVIDENCE_ROWS) setEvidence(rows);
        }}
      />

      {outcome.kind === "failure" && (
        <FailureNotice code={outcome.failure.code} message={outcome.failure.message} />
      )}

      <p className="text-[11px] text-muted-foreground px-1" role="note">
        Submitting sends your report to Buttler's human moderators. It does{" "}
        <strong>not</strong> change the map or the listing until a moderator
        reviews and approves it.
      </p>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting || (kind !== "new_location" && !targetResolved)}
          className="px-5 py-2.5 rounded-full text-sm font-semibold text-white bg-primary hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60 transition-colors"
        >
          {submitting ? "Sending…" : "Submit contribution"}
        </button>
        <Link
          href="/my-contributions"
          className="text-sm font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded px-1"
        >
          My contributions
        </Link>
      </div>
    </form>
  );
}

function FieldInput({
  spec,
  value,
  onChange,
}: {
  spec: FieldSpec;
  value: string | boolean | undefined;
  onChange: (next: string | boolean) => void;
}) {
  const inputId = `contribute-field-${spec.key}`;
  const options = fieldOptionsFor(spec.key);

  if (spec.control === "checkbox") {
    return (
      <label className="flex items-start gap-2 text-sm text-foreground cursor-pointer">
        <input
          id={inputId}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 w-4 h-4 accent-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        />
        <span>
          {spec.label}
          {spec.required && <span className="text-red-600"> *</span>}
        </span>
      </label>
    );
  }

  return (
    <div>
      <label htmlFor={inputId} className="block text-xs font-semibold text-foreground mb-1">
        {spec.label}
        {spec.required && <span className="text-red-600"> *</span>}
      </label>
      {spec.control === "select" && options ? (
        <select
          id={inputId}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          className="w-full px-3 py-2 text-sm bg-muted/60 border border-border/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="">Choose…</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : spec.control === "textarea" ? (
        <textarea
          id={inputId}
          value={typeof value === "string" ? value : ""}
          onChange={(event) =>
            onChange(event.target.value.slice(0, (spec.maxLength ?? 300) + 100))
          }
          maxLength={spec.maxLength}
          rows={3}
          className="w-full px-3 py-2 text-sm bg-muted/60 border border-border/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      ) : (
        <input
          id={inputId}
          type={spec.control === "number" ? "number" : "text"}
          step={spec.control === "number" ? "any" : undefined}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          maxLength={spec.maxLength}
          className="w-full px-3 py-2 text-sm bg-muted/60 border border-border/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      )}
      {spec.hint && (
        <p className="text-[11px] text-muted-foreground mt-0.5">{spec.hint}</p>
      )}
    </div>
  );
}

function TargetPicker({
  catalogue,
  pickedId,
  pickedName,
  onPick,
  onClear,
}: {
  catalogue: CataloguePlace[];
  pickedId: string | null;
  pickedName: string | null;
  onPick: (id: string, name: string) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return catalogue
      .filter(
        (place) =>
          typeof place.id === "string" &&
          (place.name.toLowerCase().includes(q) ||
            (place.address ?? "").toLowerCase().includes(q)),
      )
      .slice(0, 8);
  }, [catalogue, query]);

  if (pickedId) {
    return (
      <div className="bg-sky-50 border border-sky-200 rounded-2xl p-3 text-sm text-sky-900 flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <span className="font-semibold">About:</span> {pickedName ?? pickedId}
        </div>
        <button
          type="button"
          onClick={onClear}
          aria-label="Change the place this report is about"
          className="text-sky-700 hover:text-sky-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded p-0.5"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <fieldset className="bg-card border border-border/50 rounded-2xl p-4 space-y-2">
      <legend className="font-display font-bold text-sm text-foreground px-1">
        Which place?
      </legend>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search the restroom list by name or address…"
        aria-label="Search for the place this report is about"
        className="w-full px-3 py-2 text-sm bg-muted/60 border border-border/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/30"
      />
      {query.trim() && matches.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No listing matched. If this is a brand-new place, choose{" "}
          <strong>New location</strong> above.
        </p>
      )}
      <ul className="space-y-1">
        {matches.map((place) => (
          <li key={String(place.id)}>
            <button
              type="button"
              onClick={() => onPick(String(place.id), place.name)}
              className="w-full text-left px-3 py-1.5 rounded-xl text-sm bg-muted/40 hover:bg-primary/10 border border-transparent hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
            >
              {place.name}
              {place.address && (
                <span className="block text-[11px] text-muted-foreground truncate">
                  {place.address}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function EvidenceEditor({
  rows,
  onChange,
}: {
  rows: EvidenceDraft[];
  onChange: (rows: EvidenceDraft[]) => void;
}) {
  function patch(index: number, next: Partial<EvidenceDraft>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...next } : row)));
  }

  return (
    <fieldset className="bg-card border border-border/50 rounded-2xl p-4 space-y-3">
      <legend className="font-display font-bold text-sm text-foreground px-1">
        Evidence <span className="font-normal text-muted-foreground">(optional)</span>
      </legend>
      <p className="text-[11px] text-muted-foreground">
        Saying "I saw it myself" helps moderators — but it is recorded as a
        claim, never as an official field verification.
      </p>
      {rows.map((row, index) => (
        <div key={index} className="space-y-2 p-3 rounded-xl bg-muted/40 border border-border/40">
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor={`evidence-type-${index}`}>
              Evidence type
            </label>
            <select
              id={`evidence-type-${index}`}
              value={row.type}
              onChange={(event) => patch(index, { type: event.target.value })}
              className="flex-1 px-2 py-1.5 text-sm bg-white border border-border/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              {EVIDENCE_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
              aria-label="Remove this evidence"
              className="text-muted-foreground hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <label className="sr-only" htmlFor={`evidence-detail-${index}`}>
            Evidence detail
          </label>
          <input
            id={`evidence-detail-${index}`}
            type="text"
            maxLength={300}
            value={row.detail}
            onChange={(event) => patch(index, { detail: event.target.value })}
            placeholder="What did you see, where is the photo, or what is the claim?"
            className="w-full px-2 py-1.5 text-sm bg-white border border-border/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          {row.type === "external_source" && (
            <input
              type="url"
              maxLength={300}
              value={row.source_url}
              onChange={(event) => patch(index, { source_url: event.target.value })}
              placeholder="https://public-source.example"
              aria-label="Source link"
              className="w-full px-2 py-1.5 text-sm bg-white border border-border/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          )}
          <label className="sr-only" htmlFor={`evidence-date-${index}`}>
            When did you observe this?
          </label>
          <input
            id={`evidence-date-${index}`}
            type="date"
            value={row.observed_at}
            onChange={(event) => patch(index, { observed_at: event.target.value })}
            aria-label="When did you observe this?"
            className="px-2 py-1.5 text-sm bg-white border border-border/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      ))}
      {rows.length < MAX_EVIDENCE_ROWS && (
        <button
          type="button"
          onClick={() => onChange([...rows, emptyEvidence()])}
          className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded px-1 py-0.5"
        >
          <Plus className="w-3.5 h-3.5" /> Add evidence
        </button>
      )}
    </fieldset>
  );
}

function SuccessPanel({
  receipt,
  onAnother,
}: {
  receipt: SubmissionReceipt;
  onAnother: () => void;
}) {
  return (
    <div
      className="bg-card border border-green-200 rounded-2xl p-6 space-y-3 text-center"
      role="status"
      aria-live="polite"
    >
      <CheckCircle2 className="w-10 h-10 text-green-600 mx-auto" />
      <h2 className="font-display font-bold text-lg text-foreground">
        Thanks — your report was received
      </h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        A human moderator will review it. Buttler's official listings only
        change after a moderator approves, so nothing on the map changed yet.
      </p>
      <div className="flex items-center justify-center gap-2 text-sm">
        <span className="font-mono text-xs text-muted-foreground break-all">
          {receipt.contributionId}
        </span>
        <StatusPill status={receipt.status} />
      </div>
      <div className="flex items-center justify-center gap-3 pt-1">
        <Link
          href="/my-contributions"
          className="px-4 py-2 rounded-full text-sm font-semibold text-white bg-primary hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
        >
          See my contributions
        </Link>
        <button
          type="button"
          onClick={onAnother}
          className="px-4 py-2 rounded-full text-sm font-semibold text-primary bg-primary/10 hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
        >
          Submit another
        </button>
      </div>
    </div>
  );
}
