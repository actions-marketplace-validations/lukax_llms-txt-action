// Entry point for action.yml. Needs Node 20+ (fetch, AbortSignal.timeout); GitHub-hosted runners have it.

import { run } from './action.mjs';

const controller = new AbortController();
const abort = () => controller.abort();
const pack = process.env.INPUT_MODE?.trim().toLowerCase() === 'inspect-context';
if (pack) { process.once('SIGINT', abort); process.once('SIGTERM', abort); }
try {
  const { ok } = await run({ env: process.env, fetch: globalThis.fetch, signal: controller.signal });
  process.exitCode = ok ? 0 : 1;
} finally {
  if (pack) { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
}
