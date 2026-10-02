// SPDX-License-Identifier: Apache-2.0
//
// Expected bytes for the spike, written out by hand from MIP-0018 Appendix A
// (test A1) so they are independent of the Compact source that emits them.

export const EVENT_NAME = 'mip-0018:token-metadata[v1]';

/** pad(32, "mip-0018:token-metadata[v1]") as lowercase hex. */
export const EVENT_NAME_HEX = Buffer.from(EVENT_NAME, 'utf8').toString('hex').padEnd(64, '0');

/** MIP-0018 Appendix A / test A1: 95 content bytes then 161 zero bytes. */
export const A1_PAYLOAD_HEX = [
  '11'.repeat(32), // domainSep
  '03', // kind = ledger
  '04' + '6e616d65' + '01' + '0a' + '41636d6520546f6b656e', // name = "Acme Token"
  '06' + '73796d626f6c' + '01' + '04' + '41434d45', // symbol = "ACME"
  '08' + '646563696d616c73' + '02' + '01' + '06', // decimals = 6
  '09' + '7374616e6461726473' + '01' + '08' + '6d69702d30303034', // standards = "mip-0004"
]
  .join('')
  .padEnd(512, '0');

if (EVENT_NAME_HEX.length !== 64 || A1_PAYLOAD_HEX.length !== 512) {
  throw new Error('expected byte constants have the wrong size');
}
if (A1_PAYLOAD_HEX.slice(0, 190).length !== 190 || /[^0]/.test(A1_PAYLOAD_HEX.slice(190))) {
  throw new Error('A1 must have 95 content bytes followed by zero padding');
}
