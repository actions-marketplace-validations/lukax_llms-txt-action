// Opt-in hosted inspection. Only explicitly named files are sent; no repository crawl.
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const MAX_BODY = 131072;
const sha = text => createHash('sha256').update(text).digest('hex');
const cell = text => String(text).replace(/[&<>|`\r\n]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','|':'&#124;','`':'&#96;','\r':' ','\n':' '}[c]));
const prop = s => String(s).replace(/[%\r\n:,]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

function readFileInside(cwd, file) {
  if (!file || isAbsolute(file) || file.includes('\\') || file.split('/').some(p => p === '..' || p === '.git') || !/\.(md|txt|json)$/i.test(file)) throw new Error('Inspect paths must name .md, .txt or .json files inside the checkout; no parent paths or .git.');
  const root = realpathSync(cwd), target = resolve(root, file);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Inspect path is outside the checkout.');
  let p = root;
  for (const part of rel.split(sep)) { p = join(p, part); if (lstatSync(p).isSymbolicLink()) throw new Error('Inspection does not follow symlinks.'); }
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BODY) throw new Error('Inspection files must be regular files no larger than 128 KiB.');
    const resolved = realpathSync(target);
    const current = lstatSync(target);
    if (current.dev !== stat.dev || current.ino !== stat.ino || resolved !== target) throw new Error('Inspection path changed during validation.');
    const buffer = Buffer.alloc(MAX_BODY + 1);
    let offset = 0, count;
    while (offset < buffer.length && (count = readSync(fd, buffer, offset, buffer.length - offset, null)) > 0) offset += count;
    const bytes = buffer.subarray(0, offset);
    if (bytes.length > MAX_BODY) throw new Error('Inspection file exceeds 128 KiB.');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally { closeSync(fd); }
}

export function validateReceipt(r, digest) {
  if (!r || r.contentDigest !== digest || r.modelRevision !== '4a43fec65a670e48835d8e8c85c705b4b0d1c907' || r.policyRevision !== 'llms-ink-inspect-1' || r.preprocessingRevision !== 'utf8-json-stringify-1' || r.enforced !== false) return false;
  if (!Number.isInteger(r.inputTokens) || r.inputTokens < 0 || !Number.isInteger(r.inspectedTokens) || r.inspectedTokens < 0 || r.inspectedTokens > r.inputTokens || !Number.isInteger(r.windows) || r.windows < 0 || r.windows > 43) return false;
  if (r.detection === 'no_finding') return r.coverage === 'complete' && r.recommendation === 'continue' && r.reason === 'no_finding' && r.inputTokens <= 8192 && r.inspectedTokens === r.inputTokens && (r.inputTokens === 0 || r.windows > 0);
  if (r.detection === 'flagged') return ['complete','partial'].includes(r.coverage) && r.recommendation === 'withhold' && ['instruction_pattern','model_detection'].includes(r.reason) && r.inputTokens <= 8192 && r.inspectedTokens > 0 && r.windows > 0;
  return r.detection === 'unknown' && r.coverage === 'none' && r.recommendation === 'withhold' && r.inspectedTokens === 0 && ['token_limit','model_unavailable','model_failure','inspection_timeout'].includes(r.reason);
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Inspection returned an empty response.');
  let size = 0; const chunks = [];
  try {
    while (true) {
      const {value, done} = await reader.read(); if(done) break;
      size += value.length; if(size > 16384) { await reader.cancel(); throw new Error('Inspection returned an oversized response.'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

export async function inspectMode({inputs, env, fetch, summary, outputs, annotate, cwd, deps}) {
  if (!inputs.apiKey) throw new Error('Hosted inspection requires an inspection-enabled api-key.');
  if (env.GITHUB_EVENT_NAME === 'pull_request_target') throw new Error('Use pull_request or workflow_dispatch for inspection, not pull_request_target.');
  const paths = inputs.inspectPaths;
  if (!paths.length || paths.length > 20 || new Set(paths).size !== paths.length) throw new Error('Set inspect-paths to 1–20 distinct file paths, one per line. Globs are not expanded.');
  // Validate every file before any content leaves the checkout.
  const files = paths.map(file => {
    let source;
    try { source = readFileInside(cwd, file); } catch { throw new Error('An inspect-path is missing, unsupported, oversized, invalid UTF-8 or a symlink. No files were sent.'); }
    let content = source;
    const format = /\.json$/i.test(file) ? 'json' : 'text';
    if (format === 'json') { try { content = JSON.parse(source); } catch { throw new Error('An inspection JSON file is invalid. No files were sent.'); } }
    const text = format === 'json' ? JSON.stringify(content) : content;
    if (!text.length || text !== new TextDecoder('utf-8', {ignoreBOM:true}).decode(new TextEncoder().encode(text))) throw new Error('Inspection content is empty or invalid Unicode. No files were sent.');
    const body = JSON.stringify({format, content});
    if (Buffer.byteLength(body) > MAX_BODY) throw new Error('An inspection request exceeds 128 KiB after JSON encoding. No files were sent.');
    return {file, body, contentDigest: sha(text), sourceDigest: sha(source)};
  });
  if (files.reduce((n,f) => n + Buffer.byteLength(f.body),0) > 1048576) throw new Error('Inspection input exceeds 1 MiB per run. No files were sent.');
  const endpoint = 'https://llms.ink/api/v0/inspect'; // Never forward inspection credentials to an environment-selected host.
  const receipts = [];
  let flagged = 0, unknown = 0, clean = 0;
  summary.push('### Hosted content inspection (experimental)', '', 'Only the listed files were submitted. No finding is not a safety guarantee.', '', '| File | Result | Coverage |', '|---|---|---|');
  for (const file of files) {
    let receipt;
    try {
      let response;
      for (let attempt=0; attempt<3; attempt++) {
        response = await fetch(endpoint, {method:'POST', redirect:'error', headers:{authorization:`Bearer ${inputs.apiKey}`,'content-type':'application/json'},body:file.body, signal:AbortSignal.timeout(65000)});
        if (![429,503].includes(response.status) || attempt===2) break;
        const retry = Number(response.headers.get('retry-after'));
        if (!Number.isFinite(retry) || retry <= 0 || retry > 60) break;
        await response.body?.cancel();
        await deps.sleep(retry * 1000);
      }
      const r = await boundedJson(response);
      if (![200,422,503].includes(response.status) || !validateReceipt(r,file.contentDigest) || (response.status !== 200 && r.detection !== 'unknown')) throw new Error('No valid receipt');
      const {detection,coverage,recommendation,reason,modelRevision,policyRevision,preprocessingRevision,contentDigest,inputTokens,inspectedTokens,windows,enforced}=r;
      receipt={detection,coverage,recommendation,reason,modelRevision,policyRevision,preprocessingRevision,contentDigest,inputTokens,inspectedTokens,windows,enforced};
    } catch {
      receipt={detection:'unknown',coverage:'none',recommendation:'withhold',reason:'inspection_incomplete',contentDigest:file.contentDigest,enforced:false};
    }
    if(receipt.detection==='flagged') flagged++;
    else if(receipt.detection==='no_finding') clean++;
    else unknown++;
    receipts.push({file:file.file,sourceDigest:file.sourceDigest,...receipt});
    summary.push(`| ${cell(file.file)} | ${receipt.detection} | ${receipt.coverage} |`);
    if(receipt.detection!=='no_finding') annotate('error','Content inspection',receipt.detection==='flagged'?'Potential prompt injection detected; review the source.':'Inspection did not complete; this file has no clean result.',`file=${prop(file.file)},`);
  }
  const report = join(env.RUNNER_TEMP || tmpdir(), 'llms-ink-inspection-'+randomUUID()+'.json');
  writeFileSync(report,JSON.stringify({version:1,experimental:true,files:receipts},null,2)+'\n',{mode:0o600});
  outputs['inspection-report']=report;
  outputs['inspection-flagged']=String(flagged);
  outputs['inspection-unknown']=String(unknown);
  outputs['inspection-clean']=String(clean);
  summary.push('',`${clean} complete without findings; ${flagged} flagged; ${unknown} incomplete.`, '', 'Receipt JSON is written to the inspection-report output path. It contains filenames, digests and results, not source text.', '');
  return flagged===0 && unknown===0;
}
