// SPDX-License-Identifier: Apache-2.0
//
// `mip0018 recheck` — re-checks one recorded case without a wallet (spec FR-053, SC-005): every check its case.json
// lists under "recheck", against the public endpoints, from the run records and saved observations of the case.
//
//   verify            the recorded transaction of a step: the indexed event(s) = the raw transaction's log ops, the
//                     node block, finality, and the expected result / payload per event
//   list              the contract's current metadata (reference consumer) = expected.json
//   noTransaction     a step that had to be refused before submission has no transaction in its record
//   operationsAbsent  a circuit's verifier key is gone from the contract (create-and-destroy)
//   colors            tokenType(domainSep, contract) — found in the mint scanner's table for that contract,
//                     domainSep and kind; held by the signer wallet (saved `wallet status --json`); the live
//                     identity has that color and the expected metadata
//
// Paths: "record", "wallet", "index" are relative to the OUTPUT directory (--out, default the case directory: where
// the signer wrote its records); "expect" is relative to the case directory.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  compareState,
  contractOperations,
  expectedStateFrom,
  listMetadata,
  loadState,
  lookupColor,
  normHex,
  projectState,
  tokenTypeHex,
  verifyEmission,
  type EventExpectation,
  type ExpectedIdentity,
  type NetworkProfile,
} from '@mip0018/midnight';
import {
  EXIT,
  NETWORK_OPTIONS,
  UsageError,
  emitJson,
  out,
  parse,
  profileFrom,
  readRecord,
  recordContract,
  recordStep,
  str,
} from './common.ts';

export const RECHECK_USAGE = `
mip0018 recheck --network <stagenet|undeployed> --case <dir> [--out <dir>] [--json]

Re-checks a recorded case without a wallet: runs every check of <dir>/case.json "recheck" (verify each recorded
transaction with its expectation, list the contract's metadata against expected.json, steps that must have no
transaction, removed verifier keys, colors through the mint scanner table and the saved wallet observation).

  --case <dir>   the case folder (case.json, expected.json, expect/*.json)
  --out <dir>    where the records and observations are (default: the case folder)
  --wait <s>     verify: keep polling the indexer for a recorded transaction (default 0)

Exit: 0 every check passes · 1 a check fails · 2 usage · 4 a transaction is not indexed / final yet
`;

interface RecheckSpec {
  verify?: { record: string; step: string; expect?: string }[];
  /** `atStep`: the state as of that step's inclusion block (`list --to-block`). */
  list?: { record: string; expect: string; atStep?: string }[];
  noTransaction?: { record: string; step: string }[];
  operationsAbsent?: { record: string; circuit: string }[];
  /** `minted: false`: the color must NOT be in the scanner table (published, never minted). */
  colors?: {
    record: string;
    domainSep: string;
    kind: 1 | 2;
    index?: string;
    wallet?: string;
    minted?: boolean;
    expectIdentity?: ExpectedIdentity;
  }[];
}

export interface RecheckResult {
  id: string;
  ok: boolean;
  pending?: boolean;
  message: string;
}

/** A domainSep for humans: its text when it is printable ASCII padded with zeros (pad(32, "…")), else hex. */
function domainLabel(domainSep: string): string {
  const b = Buffer.from(normHex(domainSep), 'hex');
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  const t = b.subarray(0, end);
  return t.length > 0 && t.every((x) => x >= 0x20 && x < 0x7f) ? `"${t.toString('latin1')}"` : `${normHex(domainSep).slice(0, 12)}…`;
}

const readJson = (p: string, what: string): unknown => {
  if (!existsSync(p)) throw new UsageError(`${what} ${p} does not exist`);
  return JSON.parse(readFileSync(p, 'utf8'));
};

export async function recheckCase(
  profile: NetworkProfile,
  caseDir: string,
  outDir: string,
  o: { waitMs?: number } = {},
): Promise<{ caseId: string; results: RecheckResult[] }> {
  const c = readJson(join(caseDir, 'case.json'), 'case file') as { id: string; recheck?: RecheckSpec };
  const spec = c.recheck ?? {};
  const results: RecheckResult[] = [];
  const add = (id: string, ok: boolean, message: string, pending = false) =>
    results.push({ id, ok, message, ...(pending ? { pending } : {}) });
  const rec = (p: string) => readRecord(join(outDir, p));
  const guard = async (id: string, f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      add(id, false, (e as Error).message);
    }
  };

  for (const v of spec.verify ?? [])
    await guard(`verify ${v.step}`, async () => {
      const r = rec(v.record);
      const expect = v.expect ? (readJson(join(caseDir, v.expect), 'expectation') as EventExpectation | EventExpectation[]) : undefined;
      const rep = await verifyEmission({
        profile,
        contract: recordContract(r, profile),
        tx: recordStep(r, v.step).tx,
        expect,
        waitMs: o.waitMs ?? 0,
      });
      const failed = rep.checks.filter((x) => !x.ok).map((x) => x.message);
      const res = rep.events
        .map((e) => `${e.classification.result}${e.classification.reason ? `(${e.classification.reason})` : ''}`)
        .join(', ');
      add(
        `verify ${v.step}`,
        rep.exitCode === 0,
        rep.exitCode === 0
          ? `tx ${rep.transaction.slice(0, 16)}… block ${rep.inclusion?.height}: ${rep.events.length} event(s) ${res}, all ${rep.checks.length} checks ok`
          : `${rep.outcome}: ${failed.join('; ')}`,
        rep.outcome === 'not-indexed',
      );
    });

  for (const l of spec.list ?? []) {
    const id = `list ${l.record}${l.atStep ? ` @${l.atStep}` : ''}`;
    await guard(id, async () => {
      const r = rec(l.record);
      const expected = expectedStateFrom(readJson(join(caseDir, l.expect), 'expectation'));
      let toBlock: number | undefined;
      if (l.atStep) {
        const s = r.steps.find((x) => x.id === l.atStep);
        if (!s?.inclusion) throw new Error(`step ${l.atStep} of ${l.record} has no inclusion block`);
        toBlock = s.inclusion.height;
      }
      const rep = await listMetadata({ profile, contract: recordContract(r, profile), ...(toBlock !== undefined ? { toBlock } : {}) });
      const cmp = compareState(projectState(rep.identities, rep.groups, rep.counts), expected);
      add(
        id,
        cmp.ok && rep.snapshot.tipMatchesNode,
        cmp.ok
          ? `${rep.identities.length} identit${rep.identities.length === 1 ? 'y' : 'ies'}, ${rep.counts.events} event(s) (${rep.counts.accepted} accepted, ${rep.counts.rejected} rejected, ${rep.counts.ignored} ignored) = ${l.expect} at block ${rep.snapshot.toBlock}${rep.snapshot.tipMatchesNode ? '' : ' (indexer tip ≠ node)'}`
          : cmp.differences.join('; '),
      );
    });
  }

  for (const n of spec.noTransaction ?? [])
    await guard(`no transaction ${n.step}`, async () => {
      const r = rec(n.record);
      const s = r.steps.find((x) => x.id === n.step);
      if (!s) throw new Error(`${n.record} has no step ${n.step}`);
      add(
        `no transaction ${n.step}`,
        !s.tx,
        s.tx ? `step ${n.step} HAS a transaction ${s.tx.hash}` : `step ${n.step} (${s.state}) was refused before submission`,
      );
    });

  for (const a of spec.operationsAbsent ?? [])
    await guard(`no key ${a.circuit}`, async () => {
      const address = recordContract(rec(a.record), profile);
      const ops = await contractOperations(profile, address);
      if (ops === null) throw new Error(`contract ${address} not found`);
      add(`no key ${a.circuit}`, !ops.includes(a.circuit), `contract operations with a key: ${ops.join(', ') || 'none'}`);
    });

  for (const k of spec.colors ?? []) {
    const id = `color ${domainLabel(k.domainSep)}/${k.kind}`;
    await guard(id, async () => {
      const address = recordContract(rec(k.record), profile);
      const color = tokenTypeHex(k.domainSep, address);
      const notes: string[] = [`tokenType = ${color}`];
      let ok = true;
      if (k.index && k.minted === false) {
        const s = loadState(join(outDir, k.index));
        if (!s) throw new Error(`no index state in ${k.index}`);
        const l = lookupColor(s, color, k.kind);
        if (l.found) {
          ok = false;
          notes.push(`expected NOT minted, but the scanner table has it (${l.entry?.contractAddress}/${l.entry?.domainSep})`);
        } else notes.push(`not minted in the scanned range [${l.scanned.from}, ${l.scanned.to}], as expected`);
      } else if (k.index) {
        const s = loadState(join(outDir, k.index));
        if (!s) throw new Error(`no index state in ${k.index}`);
        const l = lookupColor(s, color, k.kind);
        const e = l.entry;
        const kindOk = e && (k.kind === 1 ? e.shielded : e.unshielded);
        if (!l.found || !e || e.contractAddress !== address || e.domainSep !== normHex(k.domainSep) || !kindOk) {
          ok = false;
          notes.push(
            `scanner table [${l.scanned.from}, ${l.scanned.to}]: ${l.found ? `${e?.contractAddress}/${e?.domainSep} without kind ${k.kind}` : 'not minted'}`,
          );
        } else
          notes.push(
            `scanner: minted ×${(k.kind === 1 ? e.shielded : e.unshielded)!.mints} first at ${(k.kind === 1 ? e.shielded : e.unshielded)!.firstMint.height}`,
          );
      }
      if (k.wallet) {
        const w = readJson(join(outDir, k.wallet), 'wallet observation') as {
          shieldedBalances?: Record<string, string>;
          unshieldedBalances?: Record<string, string>;
        };
        const b = (k.kind === 1 ? w.shieldedBalances : w.unshieldedBalances)?.[color];
        if (!b || BigInt(b) <= 0n) {
          ok = false;
          notes.push(`the wallet observation holds no ${k.kind === 1 ? 'shielded coin' : 'unshielded UTXO'} of this color`);
        } else notes.push(`wallet holds ${b} of it (${k.kind === 1 ? 'shielded' : 'unshielded'})`);
      }
      if (k.expectIdentity) {
        const rep = await listMetadata({ profile, contract: address });
        const v = rep.identities.find((x) => x.domainSep === normHex(k.domainSep) && x.kind === k.kind);
        const liveColor = v?.color ? Buffer.from(v.color).toString('hex') : undefined;
        const cmp = compareState(projectState(v ? [v] : [], []), { identities: [k.expectIdentity], groups: [] });
        if (!cmp.ok || liveColor !== color) {
          ok = false;
          notes.push(`live identity: ${cmp.differences.join('; ') || ''}${liveColor !== color ? ` color ${liveColor ?? '-'}` : ''}`);
        } else notes.push(`live identity ${k.expectIdentity.common.symbol ?? ''} visible=${v!.visible}`);
      }
      add(id, ok, notes.join('; '));
    });
  }

  return { caseId: c.id, results };
}

export async function cmdRecheck(argv: string[]): Promise<number> {
  const v = parse(argv, { ...NETWORK_OPTIONS, case: { type: 'string' }, out: { type: 'string' }, wait: { type: 'string' } }, RECHECK_USAGE);
  const profile = profileFrom(v);
  const caseDir = resolve(str(v, 'case', true)!);
  const outDir = resolve(str(v, 'out') ?? caseDir);
  const wait = str(v, 'wait');
  if (wait !== undefined && !/^\d+$/u.test(wait)) throw new UsageError('--wait expects seconds');
  const r = await recheckCase(profile, caseDir, outDir, { waitMs: Number(wait ?? 0) * 1000 });
  const ok = r.results.length > 0 && r.results.every((x) => x.ok);
  const pending = r.results.some((x) => x.pending);
  if (v.json) emitJson({ case: r.caseId, network: profile.id, ok, results: r.results });
  else {
    out(`case ${r.caseId}  network ${profile.id}  ${caseDir}`);
    const w = Math.max(28, ...r.results.map((x) => x.id.length));
    for (const x of r.results) out(`  ${x.ok ? 'OK  ' : x.pending ? 'WAIT' : 'FAIL'} ${x.id.padEnd(w)} ${x.message}`);
    out(`result ${ok ? 'ok' : pending ? 'pending' : 'FAILED'} (${r.results.filter((x) => x.ok).length}/${r.results.length})`);
  }
  if (r.results.length === 0) {
    process.stderr.write('mip0018: the case lists no recheck\n');
    return EXIT.failed;
  }
  return ok ? EXIT.ok : pending ? EXIT.pending : EXIT.failed;
}
