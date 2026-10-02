# packages/compact (planned, S2)

The Compact library an issuer adds to a contract: the MIP-0018 event name constant, the typed record builders (default; Compact serializes fixed-size records so the compiler checks every type) and the alternative built from individual pure circuits, header (`domainSep`, `kind`), zero padding and the `emit`. Byte equality with `vectors/` is tested by executing the compiled circuits in compact-runtime 0.20.0.

Compiled with Compact 0.35.0 and `--feature-zkir-v3`. The S0 toolchain gate that proves this toolchain end to end is in `test-contracts/toolchain-spike`.
