// SPDX-License-Identifier: Apache-2.0
//
// File-backed private-state provider — promoted to @mip0018/midnight/signer (S4). The package version stores the
// same JSON (strings stay strings), plus typed encodings for bytes and bigints; files written by S0 still load.

export { filePrivateStateProvider } from '@mip0018/midnight/signer';
