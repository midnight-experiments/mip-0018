// @mip0018/codec — dependency-free MIP-0018 TokenMetadata codec.
// Pinned text: midnightntwrk/midnight-improvement-proposals@338ea194bbe7c4e5d1829234a503b7c1b11ebf0f (PR #372).
export {
  DOMAIN_SEP_SIZE,
  EVENT_NAME,
  EVENT_NAME_TEXT,
  HEADER_SIZE,
  IMAGE_SHA256_SIZE,
  Kind,
  MAX_VALUE_SIZE,
  MISC_EVENT_TYPE,
  NAME_MAX_CHARS,
  NAME_SIZE,
  PAYLOAD_SIZE,
  SYMBOL_MAX_CHARS,
  UINT_MAX_BYTES,
  UINT_MIN_BYTES,
  ValType,
  type IgnoreReason,
  type RejectReason,
} from './constants.ts';
export {
  decodePayload,
  type DecodedRecord,
  type DecodeFail,
  type DecodeOk,
  type DecodeResult,
  type Header,
  type MetadataRecord,
} from './decode.ts';
export {
  COMMON_KEY_TEXTS,
  commonRecords,
  encodePayload,
  InvalidHeader,
  InvalidRecord,
  PayloadTooLarge,
  record,
  recordsSize,
  withdrawRecords,
} from './encode.ts';
export { classifyEvent, isMip0018Name, splitMiscData, type Classification, type ObservedMisc } from './classify.ts';
export { checkValue, decodeUint, decodeUtf8, encodeUint, minimalUintWidth } from './values.ts';
export { isRfc3986Uri, RFC3986_URI } from './uri.ts';
export { bytesEqual, fromHex, toHex, zeroExtend } from './hex.ts';
