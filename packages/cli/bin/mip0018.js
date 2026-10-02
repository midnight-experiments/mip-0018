#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// mip0018 — the MIP-0018 reference CLI (Node >= 24 runs the TypeScript sources directly).
import { main } from '../src/main.ts';

process.exit(await main(process.argv.slice(2)));
