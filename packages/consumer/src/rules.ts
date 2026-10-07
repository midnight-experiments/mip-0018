// The reducer's MIP rules as switches. Every switch is ON in the public API; they exist only so the rule-mutation
// test can disable one rule at a time and show that at least one normative vector then fails.
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
   * mutation: a Null record at any key deletes every field of the identity (a wrong rule the vectors must catch).
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
  /**
   * Keys — only the common keys and the keys of standards the token currently declares in `standards` are served.
   * Disabled = the `serveAllKeys` mutation: every stored key is served.
   */
  servedKeysOnly: boolean;
  /**
   * Keys — the served keys follow the token's current `standards`: when `standards` changes, the served keys are
   * recomputed from the stored records. Disabled = the `noRecomputeOnStandardsChange` mutation: a key is served or
   * not according to the `standards` in force when its record arrived.
   */
  recomputeServedKeys: boolean;
  /**
   * An identity with no served field is not referenced (listings, lookups, groups, history), as if it had no fields.
   * Disabled = the `listUnservedIdentity` mutation: it is reported without fields.
   */
  hideUnservedIdentity: boolean;
  /** Common fields — `name`/`symbol` must not be empty. */
  nonEmptyText: boolean;
  /**
   * Common fields — a `name`/`symbol` over 64 / 12 characters is served as its first 64 / 12 characters. Disabled =
   * the `noTruncation` mutation.
   */
  truncateLength: boolean;
  /**
   * Terminology — a character is a grapheme cluster (Unicode UAX #29). Disabled = the `truncateByCodePoints` mutation:
   * lengths count Unicode code points.
   */
  truncateGraphemes: boolean;
  /** Common fields — `image` must be a URI (type 4) and `image_sha256` exactly 32 bytes (type 0). */
  imageForm: boolean;
  /**
   * Common fields — content from `image` whose SHA-256 differs from a set `image_sha256` is not displayed. Disabled =
   * the `ignoreImageHash` mutation.
   */
  imageHash: boolean;
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
  servedKeysOnly: true,
  recomputeServedKeys: true,
  hideUnservedIdentity: true,
  nonEmptyText: true,
  truncateLength: true,
  truncateGraphemes: true,
  imageForm: true,
  imageHash: true,
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
