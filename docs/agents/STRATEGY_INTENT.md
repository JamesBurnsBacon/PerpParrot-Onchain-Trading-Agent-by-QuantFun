# Strategy-intent preview boundary

`packages/shared/strategy-intent.ts` provides the strict intent schema, parser,
simulation-policy compiler and deterministic shortlist helpers. The backend chat
handlers and the `/parrot` UI use its intent contract; chat strategy selection uses
its shortlist helper. See [the Parrot integration guide](../parrot/INTEGRATION.md)
for the endpoint and UI flow.

The module itself does not call a model, read secrets, fetch data, persist intent or
place orders. The `intentToPreview` policy compiler described below always
produces a **simulation preview**. It is not the separate live-session authorization
path, and using the shared intent schema does not grant execution authority.

## Contract and safety boundary

The JSON schema allows only style, maximum source count, diversification and leverage
comfort enums, an optional requested leverage, clone preference, horizon, a
clarification question, and a short reply. It cannot express wallet addresses,
allocations, arbitrary thresholds, exchange actions, or a deployment mode. Parsing
rechecks the schema in code because structured output is a formatting constraint, not
authorization or business-policy validation.

The parser snapshots own data descriptors once and rejects accessors, extra fields,
symbols, malformed values, control characters, and hidden/bidirectional characters.
The policy mapper snapshots and validates against the existing runtime policy schema.
It intersects requested limits with the existing base policy, never expands its
source-weight, leverage, cash-buffer, correlation, or overlap bounds, and validates
the result again. It emits `SIMULATION` and `SIMULATION_PREVIEW` unconditionally; a
chat request cannot produce a live policy. If the model indicates that it needs more
information, compilation and shortlisting stop until that clarification is answered.

The simulation compiler enforces two user-intent and control boundaries:

- `maxSources` is treated as a real maximum. If the risk ceilings require more
  independent source slots than the visitor asked for, compilation fails with an
  infeasibility message instead of silently increasing their requested count.
- Live eligibility is not inferred from the visitor's risk label. The result is
  always a simulation preview requiring a separate approval/deployment path, even if
  the frozen base policy is live.

Feasibility uses decimal-rational arithmetic over the validated JSON-number values, so
an exact `0.1` weight and `0.4` cash buffer correctly require six source slots instead
of relying on a floating-point epsilon. The shortlist takes strict candidate-shaped
rows, drops malformed or explicitly excluded rows, optionally removes clones,
collapses case-insensitive duplicate addresses, and applies a total deterministic
ordering. It returns addresses only; it cannot create weights.

## How the research informed the design

The [OpenAI DevDay Structured Outputs video](https://www.youtube.com/watch?v=kE4BkATIl9c)
is described by OpenAI as a method for precise JSON-schema adherence. The video
description and the [official Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs)
inform the shape constraint: require a closed object with bounded fields and enum
choices. I could verify the official video metadata and guide, but not a reliable full
transcript, so I do not attribute additional detailed claims to the speaker. The
engineering conclusion is that schema adherence only constrains syntax; the local
parser, policy validator, deterministic mapper, and approval boundary still own
authorization and risk semantics.

## Validation

`packages/backend/test/strategy-intent.test.ts` covers the closed schema, malicious
object shapes and accessors, proxy traps, immutable snapshots, base-policy validation,
monotonic risk limits, leverage clamps, exact feasibility, clarification stops,
deterministic shortlist order, duplicate addresses, exclusions, clone handling, and
input limits. The module is typechecked with the backend package. This build does not
replace or modify the Score ranking implementation, the review/freeze steps, or
executor authorization.

The typed bridge is implemented in `packages/backend/src/strategy-intent-adapter.ts`.
It maps only actual ranked finalists, uses Score's native non-annualised
`metrics.realizedVol`, and keeps clone status tri-state. If a visitor asks to avoid
clones, only sources with explicit `false` evidence survive; unknown status is not
treated as proof of independence. The current Score pipeline has no clone detector,
so callers must supply verified clone evidence for this option to retain candidates.
