// Explicit whole-pack inspection. Uses the bundled CLI implementation, never a
// checkout-provided executable or a package installed while holding credentials.
import { mkdtemp, readFile, realpath, rm, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { cmdContextInspection } from './generated/context-inspection.mjs';

const cell = value => String(value).replace(/[&<>|`\r\n]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '`': '&#96;', '\r': ' ', '\n': ' ' }[c]));
const prop = value => String(value).replace(/[%\r\n:,]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
const posix = value => value.split(sep).join('/');
const defaults = { 'inspection-report': '', 'inspection-status': 'invalid', 'inspection-recommendation': 'withhold',
  'inspection-clean': '0', 'inspection-flagged': '0', 'inspection-unknown': '0', 'inspection-not-attempted': '0' };

export async function inspectContextMode({ inputs, env, fetch, packSleep, signal, summary, outputs, annotate, log, cwd }) {
  Object.assign(outputs, defaults);
  if (!inputs.inspectDir) throw new Error('Set inspect-dir to the explicit context directory to upload.');
  if (inputs.inspectPaths.length) throw new Error('Use inspect-dir alone in inspect-context mode; inspect-paths belongs to inspect mode.');
  if (!/^lk_[A-Za-z0-9]{32}$/.test(inputs.apiKey)) throw new Error('Hosted pack inspection requires an inspection-enabled api-key.');
  if (env.GITHUB_EVENT_NAME === 'pull_request_target') throw new Error('Use pull_request or workflow_dispatch for inspection, not pull_request_target.');

  let work, reportDir, retained = false;
  try {
    const root = await realpath(cwd), temp = await realpath(env.RUNNER_TEMP || tmpdir());
    if (/[\x00-\x1f\x7f]/.test(root + temp)) throw new Error('Invalid workspace or runner temporary directory.');
    const within = relative(resolve(root, inputs.inspectDir), temp);
    if (within === '' || (!isAbsolute(within) && within !== '..' && !within.startsWith('..' + sep)))
      throw new Error('Runner temporary storage must be outside the selected pack.');
    reportDir = await mkdtemp(join(temp, 'llms-ink-context-inspection-'));
    // The CLI only writes receipts inside its workspace. Reserve a fresh private
    // directory outside the selected pack, then move metadata to RUNNER_TEMP.
    work = await mkdtemp(join(root, '.llms-ink-inspect-'));
    const manifest = join(work, 'manifest.json'), receiptPath = posix(relative(root, manifest));
    const capture = async (mode, args, requestSignal) => {
      let stdout = '';
      const code = await cmdContextInspection(mode, args, { cwd: root, env: { LLMS_INK_INSPECT_KEY: inputs.apiKey },
        fetch, signal: requestSignal, sleep: packSleep, stdout: { write: value => { stdout += value; } },
        stderr: { write: value => {
          // Only fixed progress lines reach logs; no paths, source or remote errors.
          const text = value.trim(); if (/^Inspected \d+\/\d+: (unknown|flagged|no_finding)\.$/.test(text)) log(text);
        } } });
      let result;
      try { result = JSON.parse(stdout); } catch { result = null; }
      return { code, result };
    };
    const scan = await capture('inspect', ['--dir', inputs.inspectDir, '--output', receiptPath], signal);
    if (!scan.result) throw new Error('Pack inspection could not publish a manifest. Check the directory, key, file types and input limits.');
    const raw = await readFile(manifest, 'utf8'), record = JSON.parse(raw);
    const verified = await capture('verify', ['--dir', inputs.inspectDir, '--receipt', receiptPath, '--quiet']);
    // A newly added symlink/unsupported file can prevent even reconstructing the
    // current pack. Preserve the fresh scan record while marking freshness invalid.
    const result = ['current', 'stale'].includes(verified.result?.status) ? verified.result : { ...scan.result, status: 'invalid' };
    if (await readFile(manifest, 'utf8') !== raw) throw new Error('Inspection report changed while saving.');
    const ok = scan.code === 0 && verified.code === 0 && !signal?.aborted;

    const report = join(reportDir, 'manifest.json');
    await copyFile(manifest, report, constants.COPYFILE_EXCL);
    if (await readFile(report, 'utf8') !== raw) throw new Error('Inspection report changed while saving.');
    Object.assign(outputs, { 'inspection-report': report, 'inspection-status': result.status,
      'inspection-recommendation': ok ? 'continue' : 'withhold', 'inspection-clean': String(result.noFinding),
      'inspection-flagged': String(result.flagged), 'inspection-unknown': String(result.unknown),
      'inspection-not-attempted': String(result.notAttempted) });
    retained = true;
    summary.push('### Context-pack inspection (experimental)', '',
      `Files: ${record.files.length}. Local snapshot: **${result.status}**. Outcome: **${ok ? 'continue' : 'withhold'}**.`, '',
      'The selected directory was explicitly submitted to llms.ink. The manifest is unsigned; no finding is not a safety guarantee.', '',
      '| File | Result | Coverage |', '|---|---|---|');
    for (const file of record.files) {
      const scan = file.inspection, receipt = scan.receipt;
      const path = inputs.inspectDir.replace(/\/+$/, '') + '/' + file.path;
      summary.push(`| ${cell(path)} | ${receipt?.detection ?? scan.state} | ${receipt?.coverage ?? 'none'} |`);
      if (receipt?.detection !== 'no_finding') annotate('error', 'Context inspection',
        receipt?.detection === 'flagged' ? 'Potential prompt injection detected; review the source.'
          : scan.state === 'not_attempted' ? 'This file was not submitted after the inspection stopped.'
            : 'Inspection did not complete for this file.', `file=${prop(path)},`);
    }
    if (!ok && result.status === 'stale') annotate('error', 'Context inspection', 'The pack changed during inspection. Review it and run a new scan.');
    else if (!ok && result.status === 'invalid') annotate('error', 'Context inspection', 'The current pack could not be verified. Resolve invalid paths or files and run a new scan.');
    else if (!ok && result.noFinding === record.files.length) annotate('error', 'Context inspection', 'The run was interrupted. Withhold the pack.');
    summary.push('', `${result.noFinding} complete without findings; ${result.flagged} flagged; ${result.unknown} unknown; ${result.notAttempted} not attempted.`, '',
      'The inspection-report output contains a metadata-only CLI manifest in the runner temporary directory. It is not committed or uploaded as an artifact automatically.',
      'Offline verification checks local bytes and supported receipt revisions, not upstream freshness. Protect the report; do not trust a pull request’s supplied manifest.', '');
    return ok;
  } catch (error) {
    outputs['inspection-recommendation'] = 'withhold';
    // Only our fixed messages are useful here; filesystem errors can contain
    // checkout-controlled paths. The CLI already suppresses raw remote failures.
    const allowed = ['Invalid workspace or runner temporary directory.',
      'Runner temporary storage must be outside the selected pack.',
      'Pack inspection could not publish a manifest. Check the directory, key, file types and input limits.',
      'The new inspection manifest could not be verified. Withhold the pack.', 'Inspection report changed while saving.'];
    throw new Error(allowed.includes(error?.message) ? error.message : 'Could not save or verify the context inspection report. Withhold the pack.');
  } finally {
    if (reportDir && !retained) await rm(reportDir, { recursive: true, force: true }).catch(() => {});
    if (work) {
      try { await rm(work, { recursive: true, force: true }); }
      catch { outputs['inspection-recommendation'] = 'withhold'; throw new Error('Could not remove the temporary inspection directory. Withhold the pack.'); }
    }
  }
}
