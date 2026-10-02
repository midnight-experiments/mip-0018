#!/usr/bin/env node
// Reference consumer adapter for the MIP-0018 vector runner (vectors/README.md, "Runner contract").
// Reads one JSON request per line on stdin and writes exactly one JSON response per line on stdout.
//
//   node vectors/tools/run.ts --consumer "node packages/consumer/bin/vector-adapter.js"
//
// To test another consumer, write the same loop in its language: parse the request, run your decoder/reducer,
// print the response object on one line.
import { createInterface } from 'node:readline';
import { handleLine } from '../src/adapter.ts';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (line.trim() === '') return;
  process.stdout.write(`${handleLine(line)}\n`);
});
