// SPDX-License-Identifier: Apache-2.0
//
// mip0018 CLI adapter for examples/openzeppelin/multi-kind (what it does: ../src/adapter.ts).
//
//   mip0018 deploy-and-publish --example multi-kind --network <id> --record <file>   compile, deploy, metadata.json steps
//   mip0018 deploy --example multi-kind …  ·  mip0018 publish --record <file> --circuit <c> --args <json> …

import { ozAdapter } from '../src/adapter.ts';

export const adapter = ozAdapter('multi-kind');
