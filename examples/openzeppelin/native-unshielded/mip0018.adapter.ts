// SPDX-License-Identifier: Apache-2.0
//
// mip0018 CLI adapter for examples/openzeppelin/native-unshielded (what it does: ../src/adapter.ts).
//
//   mip0018 deploy-and-publish --example native-unshielded --network <id> --record <file>   compile, deploy, metadata.json steps
//   mip0018 deploy --example native-unshielded …  ·  mip0018 publish --record <file> --circuit <c> --args <json> …

import { ozAdapter } from '../src/adapter.ts';

export const adapter = ozAdapter('native-unshielded');
