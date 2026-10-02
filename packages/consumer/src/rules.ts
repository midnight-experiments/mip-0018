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
  /** Null record (tombstone) — deletes its field: no current value, no earlier value, no fallback. */
  tombstoneDeletes: boolean;
  /**
   * Null record — deletes only its own field; the identity's other fields stay. Disabled = the `tombstoneIdentityWide`
   * mutation: a Null record at any key deletes every field of the identity (the rule of the earlier MIP pin 78ecbb4).
   */
  tombstonePerKey: boolean;
  /**
   * A token identity exists only while at least one of its fields has a value: once its last field is deleted it is
   * not referenced at all (listings, lookups, groups, history), and Null records alone never create one. Disabled =
   * the `keepEmptyIdentity` mutation: an identity without fields is still reported.
   */
  removeEmptyIdentity: boolean;
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
  tombstoneDeletes: true,
  tombstonePerKey: true,
  removeEmptyIdentity: true,
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
