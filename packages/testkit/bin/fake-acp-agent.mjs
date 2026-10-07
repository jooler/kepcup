#!/usr/bin/env node
// Subprocess entry of the scripted fake ACP agent (D72, packages/testkit/src/
// fake-acp-agent.ts). Run with Electron's Node (ELECTRON_RUN_AS_NODE=1) or any
// Node ≥ 22.18: the .ts module loads through Node's built-in type stripping.
//
//   fake-acp-agent.mjs <script.json> [record.jsonl]
//
// stdout is the ACP channel — nothing else may be written to it.
import { readFileSync } from 'node:fs';

const [scriptFile, recordFile] = process.argv.slice(2);
if (scriptFile === undefined) {
  console.error('usage: fake-acp-agent.mjs <script.json> [record.jsonl]');
  process.exit(2);
}
const { runFakeAcpAgentStdio } = await import('../src/fake-acp-agent.ts');
const script = JSON.parse(readFileSync(scriptFile, 'utf8'));
runFakeAcpAgentStdio(script, recordFile !== undefined ? { recordPath: recordFile } : {});
