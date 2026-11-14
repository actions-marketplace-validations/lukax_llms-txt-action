// Entry point for action.yml. Needs Node 20+ (fetch, AbortSignal.timeout); GitHub-hosted runners have it.

import { run } from './action.mjs';

const { ok } = await run({ env: process.env, fetch: globalThis.fetch });
process.exitCode = ok ? 0 : 1;
