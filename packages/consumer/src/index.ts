// @mip0018/consumer — reference MIP-0018 consumer (dependency-free apart from @mip0018/codec).
// Pinned text: midnightntwrk/midnight-improvement-proposals@6a0a59de6adf6633410b4331b2c72183cdc1a439 (PR #372).
export {
  ChainOrderError,
  MetadataState,
  type ApplyResult,
  type CommonFields,
  type DisplayResult,
  type FieldValue,
  type FieldView,
  type HistoryEntry,
  type IdentityView,
  type MetadataStateOptions,
  type ObservedEvent,
  type Position,
  type SymbolGroup,
  type TokenTypeFn,
} from './state.ts';
export {
  COMMON_KEYS,
  commonFieldUsable,
  formatAmount,
  KEY_DECIMALS,
  KEY_NAME,
  KEY_STANDARDS,
  KEY_SYMBOL,
  parseStandards,
  type FormatOptions,
} from './common.ts';
export { handleLine, handleRequest, type AdapterOptions } from './adapter.ts';
