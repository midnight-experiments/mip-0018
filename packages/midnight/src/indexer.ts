// SPDX-License-Identifier: Apache-2.0
//
// Midnight indexer client (GraphQL v4, schema of indexer 4.4.0-rc.1 — the version Stagenet serves).
//
// The contract-event surfaces (`contractEvents`, `MiscContractEvent`) are marked `@beta` in the schema; every query
// that touches them is in this module, so a schema change breaks here, loudly (GraphQL errors are thrown, never
// swallowed). Hex values are lowercase without `0x`. The indexer ingests FINALIZED blocks only, so everything read
// here is final; `latestBlock()` is the latest finalized block it has indexed.

import { HttpClient } from './http.ts';
import { normAddress, normHex, normTxHash } from './hex.ts';
import { subscribe, type SubscribeOptions } from './ws.ts';

export class IndexerError extends Error {
  override name = 'IndexerError';
}

/** The page size cap the indexer applies (`limit` is clamped to 1..=500). */
export const MAX_PAGE = 500;

export interface BlockRef {
  height: number;
  hash: string;
}

export interface BlockInfo extends BlockRef {
  timestamp: number;
}

export type TransactionStatus = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE';

export interface TransactionResult {
  status: TransactionStatus;
  segments: { id: number; success: boolean }[] | null;
}

export interface ContractActionRef {
  __typename: 'ContractDeploy' | 'ContractCall' | 'ContractUpdate' | string;
  address: string;
  entryPoint?: string;
}

export interface IndexedTransaction {
  __typename: 'RegularTransaction' | 'SystemTransaction' | string;
  id: number;
  hash: string;
  raw: string;
  block: BlockInfo;
  identifiers?: string[];
  fee?: string;
  transactionResult?: TransactionResult;
  contractActions: ContractActionRef[];
}

export interface IndexedMiscEvent {
  __typename: string;
  id: number;
  contractAddress: string;
  transactionId: number;
  raw: string;
  /** 32-byte name (hex); empty when the indexer could not decode the logged value. */
  name: string;
  /** 256-byte payload (hex); empty when the indexer could not decode the logged value. */
  payload: string;
  transaction: { id: number; hash: string; block: BlockRef; transactionResult?: TransactionResult };
}

export interface ScannedTransaction {
  __typename: string;
  id: number;
  hash: string;
  raw: string;
  contractActions: { __typename: string; address: string }[];
  transactionResult?: TransactionResult;
}

export interface ScannedBlock {
  height: number;
  hash: string;
  timestamp: number;
  parent: { hash: string } | null;
  transactions: ScannedTransaction[];
}

export const TX_FIELDS = `
  __typename id hash raw
  block { height hash timestamp }
  contractActions { __typename address ... on ContractCall { entryPoint } }
  ... on RegularTransaction { identifiers fee transactionResult { status segments { id success } } }
`;

export const EVENT_FIELDS = `
  __typename id contractAddress transactionId raw
  ... on MiscContractEvent { name payload }
  transaction { id hash block { height hash } ... on RegularTransaction { transactionResult { status segments { id success } } } }
`;

export const SCAN_BLOCK_FIELDS = `
  height hash timestamp parent { hash }
  transactions {
    __typename id hash raw
    contractActions { __typename address }
    ... on RegularTransaction { transactionResult { status segments { id success } } }
  }
`;

export const QUERIES = {
  latestBlock: `query { block { height hash timestamp } }`,
  blockByHeight: `query ($h: Int!) { block(offset: { height: $h }) { height hash timestamp } }`,
  scanBlock: `query ($h: Int!) { block(offset: { height: $h }) { ${SCAN_BLOCK_FIELDS} } }`,
  scanBlocks: `subscription ($h: Int!) { blocks(offset: { height: $h }) { ${SCAN_BLOCK_FIELDS} } }`,
  transactionByHash: `query ($hash: HexEncoded!) { transactions(offset: { hash: $hash }) { ${TX_FIELDS} } }`,
  contractEvents: `query ($filter: ContractEventFilter!, $limit: Int!, $offset: Int!) {
    contractEvents(filter: $filter, limit: $limit, offset: $offset) { ${EVENT_FIELDS} }
  }`,
  verifyBundle: `query ($addr: HexEncoded!, $tx: HexEncoded!, $limit: Int!) {
    block { height hash timestamp }
    contractEvents(filter: { contractAddress: $addr, transactionHash: $tx, types: [MISC] }, limit: $limit, offset: 0) { ${EVENT_FIELDS} }
    transactions(offset: { hash: $tx }) { ${TX_FIELDS} }
  }`,
  contractState: `query ($address: HexEncoded!) {
    contractAction(address: $address) { __typename state transaction { hash block { height hash } } }
  }`,
  contractActions: `subscription ($address: HexEncoded!, $h: Int!) {
    contractActions(address: $address, offset: { height: $h }) {
      __typename address ... on ContractCall { entryPoint }
      transaction { hash block { height hash } }
    }
  }`,
} as const;

export interface ContractEventFilter {
  fromBlock?: number;
  toBlock?: number;
  transactionHash?: string;
}

export class Indexer {
  readonly url: string;
  readonly wsUrl: string;
  readonly http: HttpClient;

  constructor(url: string, wsUrl: string, http?: HttpClient) {
    this.url = url;
    this.wsUrl = wsUrl;
    this.http = http ?? new HttpClient();
  }

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const body = await this.http.postJson<{ data?: T; errors?: unknown }>(this.url, { query, variables });
    if (body.errors !== undefined) throw new IndexerError(`indexer GraphQL error: ${JSON.stringify(body.errors)}`);
    if (body.data === undefined) throw new IndexerError('indexer returned no data');
    return body.data;
  }

  async latestBlock(): Promise<BlockInfo> {
    const d = await this.query<{ block: BlockInfo | null }>(QUERIES.latestBlock);
    if (!d.block) throw new IndexerError('the indexer has no block yet');
    return d.block;
  }

  async blockByHeight(height: number): Promise<BlockInfo | null> {
    return (await this.query<{ block: BlockInfo | null }>(QUERIES.blockByHeight, { h: height })).block;
  }

  async scanBlock(height: number): Promise<ScannedBlock | null> {
    return (await this.query<{ block: ScannedBlock | null }>(QUERIES.scanBlock, { h: height })).block;
  }

  async transactionByHash(hash: string): Promise<IndexedTransaction | null> {
    const d = await this.query<{ transactions: IndexedTransaction[] }>(QUERIES.transactionByHash, { hash: normTxHash(hash) });
    return d.transactions[0] ?? null;
  }

  /** One page of a contract's Misc events (ordered by event id). `limit` is capped at 500 by the indexer. */
  async contractEventsPage(contractAddress: string, f: ContractEventFilter, limit: number, offset: number): Promise<IndexedMiscEvent[]> {
    if (limit < 1 || limit > MAX_PAGE) throw new IndexerError(`limit must be 1..${MAX_PAGE}`);
    const filter: Record<string, unknown> = { contractAddress: normAddress(contractAddress), types: ['MISC'] };
    if (f.fromBlock !== undefined) filter.fromBlock = f.fromBlock;
    if (f.toBlock !== undefined) filter.toBlock = f.toBlock;
    if (f.transactionHash !== undefined) filter.transactionHash = normTxHash(f.transactionHash);
    const d = await this.query<{ contractEvents: IndexedMiscEvent[] }>(QUERIES.contractEvents, { filter, limit, offset });
    return d.contractEvents;
  }

  /**
   * Every Misc event of a contract matching the filter. Pages with `offset` and stops only on an EMPTY page, so a
   * server that silently returns fewer rows than asked can never truncate the result. Refuses (throws) above
   * `maxEvents`, on a page larger than requested, and on non-increasing or duplicate ids.
   */
  async allContractEvents(
    contractAddress: string,
    f: ContractEventFilter,
    o: { pageSize?: number; maxEvents?: number } = {},
  ): Promise<{ events: IndexedMiscEvent[]; pages: number }> {
    const pageSize = o.pageSize ?? MAX_PAGE;
    const maxEvents = o.maxEvents ?? 100_000;
    const out: IndexedMiscEvent[] = [];
    let pages = 0;
    for (let offset = 0; ;) {
      const page = await this.contractEventsPage(contractAddress, f, pageSize, offset);
      pages++;
      if (page.length > pageSize) throw new IndexerError(`indexer returned ${page.length} events for a page of ${pageSize}`);
      if (page.length === 0) break;
      for (const e of page) {
        const prev = out[out.length - 1];
        if (prev !== undefined && e.id <= prev.id) throw new IndexerError(`event ids not strictly increasing (${prev.id} then ${e.id})`);
        out.push(e);
      }
      if (out.length > maxEvents)
        throw new IndexerError(`more than ${maxEvents} events; refusing to return a partial list (raise --max-events)`);
      offset += page.length;
    }
    return { events: out, pages };
  }

  /** Events of one contract in one transaction + the transaction + the indexer tip, in ONE request. */
  async verifyBundle(
    contractAddress: string,
    txHash: string,
  ): Promise<{ tip: BlockInfo; events: IndexedMiscEvent[]; transaction: IndexedTransaction | null }> {
    const d = await this.query<{ block: BlockInfo; contractEvents: IndexedMiscEvent[]; transactions: IndexedTransaction[] }>(
      QUERIES.verifyBundle,
      { addr: normAddress(contractAddress), tx: normTxHash(txHash), limit: MAX_PAGE },
    );
    if (d.contractEvents.length >= MAX_PAGE)
      throw new IndexerError(`${MAX_PAGE} or more events in one transaction; refusing a possibly partial list`);
    return { tip: d.block, events: d.contractEvents, transaction: d.transactions[0] ?? null };
  }

  /** The contract's latest serialized state (hex) and the transaction that produced it, or null if unknown. */
  async contractState(contractAddress: string): Promise<{ state: string; txHash: string; block: BlockRef; action: string } | null> {
    const d = await this.query<{
      contractAction: null | { __typename: string; state: string; transaction: { hash: string; block: BlockRef } };
    }>(QUERIES.contractState, { address: normAddress(contractAddress) });
    if (!d.contractAction) return null;
    return {
      state: normHex(d.contractAction.state),
      txHash: d.contractAction.transaction.hash,
      block: d.contractAction.transaction.block,
      action: d.contractAction.__typename,
    };
  }

  /** Polls `transactions(offset:{hash})` until the transaction is indexed or the time is up (undefined = not seen). */
  async waitForTransaction(
    hash: string,
    o: { timeoutMs: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> },
  ): Promise<IndexedTransaction | undefined> {
    const until = Date.now() + o.timeoutMs;
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (;;) {
      const t = await this.transactionByHash(hash);
      if (t) return t;
      if (Date.now() >= until) return undefined;
      await sleep(o.intervalMs ?? 2_000);
    }
  }

  /** Streams blocks from `height` (inclusive) over the indexer's `blocks` subscription. */
  subscribeBlocks(height: number, o: SubscribeOptions = {}): AsyncGenerator<{ blocks: ScannedBlock }> {
    return subscribe<{ blocks: ScannedBlock }>(this.wsUrl, QUERIES.scanBlocks, { h: height }, o);
  }

  /** All actions of a contract from `height`, oldest first (deploy first), up to `untilHeight` (the subscription never ends by itself). */
  async contractActions(
    contractAddress: string,
    fromHeight: number,
    untilHeight: number,
    o: SubscribeOptions = {},
  ): Promise<{ __typename: string; address: string; entryPoint?: string; transaction: { hash: string; block: BlockRef } }[]> {
    type A = { __typename: string; address: string; entryPoint?: string; transaction: { hash: string; block: BlockRef } };
    const out: A[] = [];
    const it = subscribe<{ contractActions: A }>(
      this.wsUrl,
      QUERIES.contractActions,
      { address: normAddress(contractAddress), h: fromHeight },
      { idleTimeoutMs: 15_000, ...o },
    );
    try {
      for await (const m of it) {
        if (m.contractActions.transaction.block.height > untilHeight) break;
        out.push(m.contractActions);
      }
    } catch (e) {
      // The subscription stays open at the tip; an idle timeout after the last action means "no more actions".
      if (!(e instanceof Error && /no message from/u.test(e.message))) throw e;
    }
    return out;
  }
}
