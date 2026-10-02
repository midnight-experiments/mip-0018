# examples/openzeppelin (planned, S3)

Minimal additions that give OpenZeppelin Compact Contracts 0.4.0-alpha.5 tokens MIP-0018 metadata, guarded by `Ownable`: `fungible-token` (kind 3), `native-shielded` (kind 1), `native-unshielded` (kind 2), `multi-kind` (one asset as kinds 1, 2 and 3, symbol grouping) and `token-family` (several `domainSep`). The S0 spike compiles OZ `Ownable` + `NativeShieldedToken` with an emitting circuit under Compact 0.35.0 / language 0.27.0.
