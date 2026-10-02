# Security

## Reporting

Report a vulnerability privately through GitHub's **Report a vulnerability** form on this repository (Security → Advisories), not in a public issue. Include the commit, the command you ran and what you observed. Issues in Midnight components themselves (node, indexer, proof server, Compact, Midnight.js, the wallet SDK) belong to their own repositories.

## Secrets

- Wallet mnemonics, seeds and contract maintenance signing keys never enter this repository, its history, logs or records.
- Scripts read a secret only from a **file path** given to them; the file must be a regular file of mode `0600` outside every Git working tree. Nothing prints a secret; errors name the file, never its content.
- Only signing runs see secrets: `docker/signer.sh` mounts the secret directory **read-only** and a private state directory (maintenance keys, wallet caches) read-write, both outside the repository; every other container (`docker/run.sh`) has no secret mounted.
- Run records committed under `deployments/` and `test-contracts/*/records/` contain public data only (addresses, transaction hashes, heights, payload bytes, versions).
- The local stack (`docker/local-stack/`) uses the dev chain's public genesis seed and throwaway service passwords; never reuse them elsewhere.
- Any SDK logger that can print seeds is kept silent; this repository does not use `testkit-js` wallet builders for that reason.

## Untrusted payloads

Every byte of a MIP-0018 payload is attacker-controlled. The reference consumer:

- bounds-checks every length before slicing and rejects the whole event on any error (MIP "Payload");
- validates UTF-8 strictly, parses JSON with the platform parser, accepts only the RFC 3986 `URI` rule for `valType` 4;
- never fetches a URI, never loads or runs code because of a `standards` value;
- takes the contract address from the event record, never from the payload, and computes colors with `tokenType`, never reading them from a value;
- never groups tokens of different contracts because their `symbol` matches.

Names and symbols are self-declared; see the MIP's Security Considerations before showing a token as a known asset.
