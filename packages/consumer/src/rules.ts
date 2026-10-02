// The reducer's MIP rules as switches. Every switch is ON in the public API; they exist only so the rule-mutation
// test (SC-001) can disable one rule at a time and show that at least one normative vector then fails.
// Not part of the public API (exported from `@mip0018/consumer/internal`).

export interface ConsumerRules {
  /** Applying records — records within an event apply in order. */
  recordOrder: boolean;
  /** Non-Null record — replaces the earlier value (latest value wins). */
  latestWins: boolean;
  /** Keys are exact bytes (no case folding, no trimming of zero bytes). */
  exactKeys: boolean;
  /** Empty strings/bytes and JSON null are ordinary values, not tombstones. */
  emptyIsValue: boolean;
  /** Null record — hides the identity. */
  tombstoneHides: boolean;
  /** Null record — clears every field and the history (nothing returns on revival). */
  tombstoneClears: boolean;
  /** Null record — withdraws the whole identity whatever its key (no per-key delete). */
  tombstoneIdentityWide: boolean;
  /** Token identity includes `kind`. */
  identityKind: boolean;
  /** Token identity includes `contractAddress` (from the event record). */
  identityContract: boolean;
  /** Token identity includes `network`. */
  identityNetwork: boolean;
  /** Reorganization — state is recomputed from the remaining canonical events. */
  rollbackRecompute: boolean;
  /** Common fields — `name`/`symbol` must not be empty. */
  nonEmptyText: boolean;
  /** Common fields — `decimals` must be an unsigned integer (type 2). */
  decimalsType: boolean;
  /** Common fields — `standards` must follow the list format. */
  standardsFormat: boolean;
  /** Common fields — an unusable current value never falls back to an earlier one. */
  noFallback: boolean;
  /** Symbol grouping — never spans contracts. */
  groupWithinContract: boolean;
  /** Symbol grouping — symbols compared as exact bytes. */
  groupExactBytes: boolean;
  /** Symbol grouping — only identities with a usable symbol. */
  groupUsableOnly: boolean;
  /** Display — amount / 10^decimals. */
  displayDecimals: boolean;
  /** A color is derived for kinds 1 and 2 only. */
  colorNativeOnly: boolean;
}

export const ALL_CONSUMER_RULES: Readonly<ConsumerRules> = Object.freeze({
  recordOrder: true,
  latestWins: true,
  exactKeys: true,
  emptyIsValue: true,
  tombstoneHides: true,
  tombstoneClears: true,
  tombstoneIdentityWide: true,
  identityKind: true,
  identityContract: true,
  identityNetwork: true,
  rollbackRecompute: true,
  nonEmptyText: true,
  decimalsType: true,
  standardsFormat: true,
  noFallback: true,
  groupWithinContract: true,
  groupExactBytes: true,
  groupUsableOnly: true,
  displayDecimals: true,
  colorNativeOnly: true,
});

export function withConsumerRules(partial: Partial<ConsumerRules> | undefined): ConsumerRules {
  return { ...ALL_CONSUMER_RULES, ...(partial ?? {}) };
}
