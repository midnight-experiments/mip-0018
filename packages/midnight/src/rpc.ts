// SPDX-License-Identifier: Apache-2.0
//
// Midnight node JSON-RPC (Substrate): the read-only calls the scripts need to cross-check the indexer.
//
//   chain_getBlockHash(h)      block hash at height h (null when the node has no such block)
//   chain_getFinalizedHead     hash of the latest finalized block
//   chain_getHeader(hash?)     header (number as 0x-hex) of a block, or of the best block
//   chain_getBlock(hash)       the block's extrinsics (hex), used to show the raw transaction bytes are in the block
//   system_version / state_getRuntimeVersion   for run records

import { HttpClient } from './http.ts';
import { normHex, to0x } from './hex.ts';

export class RpcError extends Error {
  override name = 'RpcError';
}

export interface Header {
  number: number;
  parentHash: string;
  hash?: string;
}

export class NodeRpc {
  readonly url: string;
  readonly http: HttpClient;

  constructor(url: string, http?: HttpClient) {
    this.url = url;
    this.http = http ?? new HttpClient();
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const body = await this.http.postJson<{ result?: T; error?: unknown }>(this.url, { id: 1, jsonrpc: '2.0', method, params });
    if (body.error !== undefined) throw new RpcError(`RPC ${method} failed: ${JSON.stringify(body.error)}`);
    if (!('result' in body)) throw new RpcError(`RPC ${method}: no result`);
    return body.result as T;
  }

  /** `0x`-prefixed lowercase hash, or null when the node does not have the height. */
  async blockHash(height: number): Promise<string | null> {
    const r = await this.call<string | null>('chain_getBlockHash', [height]);
    return r === null ? null : to0x(r);
  }

  async genesisHash(): Promise<string> {
    const h = await this.blockHash(0);
    if (h === null) throw new RpcError('the node returned no genesis hash');
    return h;
  }

  async header(hash?: string): Promise<Header> {
    const h = await this.call<{ number: string; parentHash: string }>('chain_getHeader', hash === undefined ? [] : [to0x(hash)]);
    return { number: Number.parseInt(h.number, 16), parentHash: to0x(h.parentHash) };
  }

  async finalizedHead(): Promise<{ hash: string; height: number }> {
    const hash = to0x(await this.call<string>('chain_getFinalizedHead'));
    const h = await this.header(hash);
    return { hash, height: h.number };
  }

  async bestHeight(): Promise<number> {
    return (await this.header()).number;
  }

  /** Extrinsics of a block as lowercase hex without `0x`. */
  async blockExtrinsics(hash: string): Promise<string[]> {
    const b = await this.call<{ block: { extrinsics: string[] } } | null>('chain_getBlock', [to0x(hash)]);
    if (b === null) throw new RpcError(`the node has no block ${hash}`);
    return b.block.extrinsics.map((x) => normHex(x));
  }

  /** Index of the extrinsic that contains `rawTxHex`, or -1. */
  async findRawTransaction(blockHash: string, rawTxHex: string): Promise<number> {
    const raw = normHex(rawTxHex);
    const xs = await this.blockExtrinsics(blockHash);
    return xs.findIndex((x) => x.includes(raw));
  }

  async systemVersion(): Promise<string> {
    return this.call<string>('system_version');
  }

  async runtimeVersion(): Promise<{ specName: string; specVersion: number; transactionVersion: number }> {
    return this.call('state_getRuntimeVersion');
  }
}
