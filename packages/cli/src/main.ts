// SPDX-License-Identifier: Apache-2.0
//
// mip0018 — the MIP-0018 reference CLI.
//
//   wallet-free:  verify · list · index · lookup · vectors run
//   signer:       wallet status|register-dust · deploy · publish · remove-circuit · deploy-and-publish · upgrade
//
// Run it through npm in the pinned image: `docker/run.sh mip0018 -- <command> …` (wallet-free) or
// `docker/signer.sh mip0018 -- <command> …` (signing). `<command> --help` prints the details.

import { EXIT, UsageError } from './common.ts';
import { cmdIndex, cmdList, cmdLookup, cmdVectors, cmdVerify } from './wallet-free.ts';

export const USAGE = `
mip0018 <command> [options]          (<command> --help for details)

wallet-free (no secret, any container):
  verify               check one emission: event, name, binding, decode, raw tx, block, finality [--expect]
  list                 every MIP-0018 event of a contract and its current metadata per token identity
  index                mint scanner: from a start height, build color → (contract, domainSep, kinds) + events
  lookup               resolve a color through the scanner's table to the identity and its metadata
  vectors run          run the test vectors against a consumer (runner contract)

signer (docker/signer.sh; wallet secret from a file):
  wallet status        public addresses and balances
  wallet register-dust register NIGHT UTxOs for DUST generation
  deploy               deploy a compiled contract (record + before/after checks)
  publish              call an emitting circuit (record + before/after checks)
  call                 the same for any circuit (e.g. a mint; no event expected unless it logs one)
  remove-circuit       VerifierKeyRemove of a circuit (create-and-destroy)
  deploy-and-publish   compile → deploy → publish → verify an example in one command
  upgrade              add a circuit (publishMetadata) to a deployed contract: VerifierKeyInsert, then call it

Exit codes: 0 ok · 1 mismatch / failed · 2 usage · 3 not found · 4 not yet indexed / outcome unknown
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'verify':
        return await cmdVerify(rest);
      case 'list':
        return await cmdList(rest);
      case 'index':
        return await cmdIndex(rest);
      case 'lookup':
        return await cmdLookup(rest);
      case 'vectors':
        return cmdVectors(rest);
      case 'wallet':
      case 'deploy':
      case 'publish':
      case 'call':
      case 'remove-circuit':
      case 'deploy-and-publish':
      case 'upgrade': {
        // The signing side loads the wallet SDK and midnight-js only when a signing command runs.
        const s = await import('./signer.ts');
        const f = {
          wallet: s.cmdWallet,
          deploy: s.cmdDeploy,
          publish: s.cmdPublish,
          call: s.cmdPublish,
          'remove-circuit': s.cmdRemoveCircuit,
          'deploy-and-publish': s.cmdDeployAndPublish,
          upgrade: s.cmdUpgrade,
        }[cmd];
        return await f(rest);
      }
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(`${USAGE.trim()}\n`);
        return cmd === undefined ? EXIT.usage : EXIT.ok;
      default:
        throw new UsageError(`unknown command "${cmd}"\n\n${USAGE.trim()}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`mip0018: ${e.message}\n`);
      return EXIT.usage;
    }
    process.stderr.write(`mip0018: ${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}\n`);
    return EXIT.failed;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
