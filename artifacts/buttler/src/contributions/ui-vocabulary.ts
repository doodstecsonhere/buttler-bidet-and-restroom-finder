// Buttler 2.0 — Stage 13 frontend: contribution UI vocabulary.
//
// The single, explicit bridge between the two vocabularies this feature speaks:
//
//   * The BACKEND vocabulary — the kind tokens, statuses, enums, and field
//     names in `lib/contributions/contract.ts`. That file is the source of
//     truth; the server refuses anything it does not list.
//   * The UI vocabulary — the friendly labels a guardian or contributor sees.
//
// Everything the browser shows or sends about a contribution kind goes through
// the tables in this file, so a reader can diff UI wording against backend
// tokens in one place, and `scripts/stage13-contribution-ui.test.mjs` fails if
// either side ever drifts.
//
// Deliberately pure: no React, no DOM, no fetch. Safe to import from Node
// tests exactly as the browser imports it.

import {
  ACCESS_VALUES,
  BIDET_PRESENCE_VALUES,
  CONTRIBUTION_KINDS,
  CONTRIBUTION_STATUSES,
  FEE_VALUES,
  isContributionKind,
} from "../../../../lib/contributions/contract.ts";
import type {
  ContributionKind,
  ContributionStatus,
} from "../../../../lib/contributions/contract.ts";

// ---------------------------------------------------------------------------
// Kind labels
// ---------------------------------------------------------------------------

/** Friendly, human label for each backend kind token. */
export const KIND_LABEL: Record<ContributionKind, string> = {
  problem_report: "Report a problem",
  closure_report: "No longer exists",
  info_correction: "Corrected information",
  access_update: "Access information",
  fee_update: "Fee information",
  bidet_report: "Bidet information",
  reverification: "Fresh verification",
  new_location: "New location",
};

/** One-line explanation shown under each label in the picker. */
export const KIND_DESCRIPTION: Record<ContributionKind, string> = {
  problem_report: "Something is wrong here — dirty, broken, closed oddly.",
  closure_report: "This place is gone or no longer a restroom.",
  info_correction: "The name, address, or map pin looks wrong.",
  access_update: "Who is allowed to use this restroom.",
  fee_update: "Whether using it costs money.",
  bidet_report: "Whether a bidet (or trowel) is available.",
  reverification: "You have seen this place recently, as described.",
  new_location: "A restroom or bidet spot Buttler does not list yet.",
};

/** Every kind token, in backend order, with its UI label and description. */
export const KIND_OPTIONS: readonly {
  kind: ContributionKind;
  label: string;
  description: string;
}[] = CONTRIBUTION_KINDS.map((kind) => ({
  kind,
  label: KIND_LABEL[kind],
  description: KIND_DESCRIPTION[kind],
}));

/**
 * Look up a label for a kind token coming back from the API. Unknown tokens
 * render as themselves — better a raw token than a wrong friendly label.
 */
export function kindLabel(kind: unknown): string {
  return isContributionKind(kind) ? KIND_LABEL[kind] : String(kind);
}

// Every existing-location kind needs a canonical target; only new_location
// stands alone. Mirrors `validateTargetForKind` in the backend contract.
const KINDS_WITHOUT_TARGET: readonly ContributionKind[] = ["new_location"];

export function kindRequiresTarget(kind: ContributionKind): boolean {
  return !KINDS_WITHOUT_TARGET.includes(kind);
}

// ---------------------------------------------------------------------------
// Status labels
// ---------------------------------------------------------------------------

export const STATUS_LABEL: Record<ContributionStatus, string> = {
  pending: "Waiting for review",
  validated: "Checked — waiting for a moderator",
  needs_review: "Flagged for a moderator",
  approved: "Approved",
  rejected: "Not approved",
  withdrawn: "Withdrawn",
  superseded: "Replaced by a newer report",
};

export function statusLabel(status: unknown): string {
  return (CONTRIBUTION_STATUSES as readonly string[]).includes(String(status))
    ? STATUS_LABEL[status as ContributionStatus]
    : String(status);
}

// ---------------------------------------------------------------------------
// Enum option labels (values are backend tokens; labels are UI text)
// ---------------------------------------------------------------------------

export interface SelectOption {
  value: string;
  label: string;
}

function options(
  values: readonly string[],
  labels: Record<string, string>,
): SelectOption[] {
  return values.map((value) => ({ value, label: labels[value] ?? value }));
}

const ACCESS_LABELS: Record<string, string> = {
  public: "Open to everyone",
  customers: "Customers only",
  "public/customers": "Public or for customers",
  permissive: "Usually okay to use",
  "students/public": "Students & public",
  restricted: "Restricted",
  unknown: "Not sure",
};

const FEE_LABELS: Record<string, string> = {
  yes: "Costs money",
  no: "Free",
  unknown: "Not sure",
};

const BIDET_LABELS: Record<string, string> = {
  Yes: "Bidet present",
  Unknown: "Not sure",
};

export const ACCESS_OPTIONS = options(ACCESS_VALUES, ACCESS_LABELS);
export const FEE_OPTIONS = options(FEE_VALUES, FEE_LABELS);
export const BIDET_OPTIONS = options(BIDET_PRESENCE_VALUES, BIDET_LABELS);

/** Option list for an enum-valued payload field, by backend field name. */
export function fieldOptionsFor(fieldKey: string): SelectOption[] | null {
  if (fieldKey === "access") return ACCESS_OPTIONS;
  if (fieldKey === "fee") return FEE_OPTIONS;
  if (fieldKey === "bidet_presence") return BIDET_OPTIONS;
  return null;
}

/** Friendly rendering of a payload value (enum tokens become UI labels). */
export function payloadValueLabel(fieldKey: string, value: unknown): string {
  const choice = fieldOptionsFor(fieldKey)?.find(
    (option) => option.value === String(value),
  );
  if (choice) return choice.label;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

// ---------------------------------------------------------------------------
// Per-kind form specs
// ---------------------------------------------------------------------------

export type FieldControl = "text" | "textarea" | "number" | "checkbox" | "select";

export interface FieldSpec {
  /** The exact backend allow-list key — never a made-up field. */
  key: string;
  label: string;
  control: FieldControl;
  required: boolean;
  maxLength?: number;
  hint?: string;
}

export const FIELDS_BY_KIND: Record<ContributionKind, readonly FieldSpec[]> = {
  problem_report: [
    {
      key: "issue",
      label: "What is the problem?",
      control: "textarea",
      required: true,
      maxLength: 300,
      hint: "A short, factual description. Up to 300 characters.",
    },
  ],
  closure_report: [
    {
      key: "closed",
      label: "This place no longer exists (or is no longer a restroom).",
      control: "checkbox",
      required: true,
    },
  ],
  info_correction: [
    { key: "name", label: "Corrected name", control: "text", required: false, maxLength: 200 },
    { key: "address", label: "Corrected address", control: "text", required: false, maxLength: 300 },
    { key: "latitude", label: "Corrected latitude", control: "number", required: false, hint: "Between 9.0 and 9.8 (Dumaguete area)." },
    { key: "longitude", label: "Corrected longitude", control: "number", required: false, hint: "Between 123.0 and 123.7 (Dumaguete area)." },
  ],
  access_update: [
    { key: "access", label: "Who can use it?", control: "select", required: true },
  ],
  fee_update: [
    { key: "fee", label: "Does it cost money?", control: "select", required: true },
  ],
  bidet_report: [
    { key: "bidet_presence", label: "Is a bidet available?", control: "select", required: true },
  ],
  reverification: [
    {
      key: "observed",
      label: "I have seen this place recently, still as described.",
      control: "checkbox",
      required: true,
    },
  ],
  new_location: [
    { key: "name", label: "Place name", control: "text", required: true, maxLength: 200 },
    { key: "latitude", label: "Latitude", control: "number", required: true, hint: "Between 9.0 and 9.8 (Dumaguete area)." },
    { key: "longitude", label: "Longitude", control: "number", required: true, hint: "Between 123.0 and 123.7 (Dumaguete area)." },
    { key: "address", label: "Address", control: "text", required: false, maxLength: 300 },
    { key: "access", label: "Who can use it?", control: "select", required: false },
    { key: "fee", label: "Does it cost money?", control: "select", required: false },
    { key: "bidet_presence", label: "Is a bidet available?", control: "select", required: false },
  ],
};

/** Friendly label for a payload field key (keys are unique across kinds). */
export const FIELD_LABEL: Record<string, string> = {
  issue: "Problem",
  closed: "No longer exists",
  name: "Name",
  address: "Address",
  latitude: "Latitude",
  longitude: "Longitude",
  access: "Access",
  fee: "Fee",
  bidet_presence: "Bidet present",
  observed: "Seen recently",
};

export function fieldLabel(key: string): string {
  return FIELD_LABEL[key] ?? key;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Evidence stays a structured, optional add-on — the same shape documented in
 * `docs/stage12-contribution-architecture.md`. `photo_reference` is a pointer
 * only; this build has no photo-upload infrastructure by design.
 */
export const EVIDENCE_TYPES: readonly SelectOption[] = [
  { value: "field_observation", label: "I saw this myself" },
  { value: "user_note", label: "A note from me or someone I trust" },
  { value: "external_source", label: "A public source (link)" },
  { value: "photo_reference", label: "A photo reference (pointer only — no upload)" },
];

export function evidenceTypeLabel(type: unknown): string {
  return (
    EVIDENCE_TYPES.find((entry) => entry.value === String(type))?.label ??
    String(type)
  );
}
