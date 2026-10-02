// SPDX-License-Identifier: Apache-2.0
// @mip0018/compact/testing — compile Compact sources with the pinned compiler and run them in
// compact-runtime 0.20.0, capturing the MIP-0018 (Misc) events each circuit call emits.
export { COMPACT_VERSION, compileError, ensureCompiled, hasKeys, type CompileOptions } from './compile.ts';
export { MISC_DATA_SIZE, Simulator, loadContractModule, miscEvents, splitMisc, type CallOutcome, type ObservedMisc } from './simulator.ts';
