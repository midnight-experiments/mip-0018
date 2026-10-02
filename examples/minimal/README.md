# examples/minimal (planned, S2)

The smallest emitter without OpenZeppelin, using the create-and-destroy pattern (Q4): an unguarded `publishMetadata()` called once after deployment, then removed with a `VerifierKeyRemove` maintenance update. The S0 spike (`test-contracts/toolchain-spike`) already proves the pattern on the local stack and Stagenet (note: the ZKIR-v3 key lives in the `v4` slot, questions Q23).
