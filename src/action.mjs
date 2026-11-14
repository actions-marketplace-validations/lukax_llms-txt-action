// The action: read inputs, run the mode, write outputs and the job summary.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, posix, resolve } from 'node:path';
import { gitHub } from './github.mjs';
import { check, checkFailed, generate, LlmsInkError } from './llms.mjs';
import { countSections, describeDiff, diffSections, diffTable } from './sections.mjs';

export const MODES = ['write', 'commit', 'pr', 'check', 'comment'];
export const PR_BRANCH = 'llms-ink/llms-txt';
const COMMENT_LIMIT = 60_000;

/** Inputs as the composite step passes them: INPUT_<NAME> with dashes as underscores. Defaults match action.yml. */
export function readInputs(env) {
  const get = (name, fallback = '') => (env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] ?? '').trim() || fallback;
  const bool = (name, fallback) => get(name, String(fallback)).toLowerCase() === 'true';
  return {
    url: get('url'),
    path: get('path', 'llms.txt'),
    fullPath: get('full-path'),
    fresh: bool('fresh', true),
    mode: get('mode', 'write').toLowerCase(),
    apiKey: get('api-key'),
    generated: bool('generated', false),
    commitMessage: get('commit-message', 'Update llms.txt'),
    branch: get('branch'),
    token: get('token'),
  };
}

/** A repo-relative POSIX path for the Git Data API; throws on absolute paths or ones that leave the repo. */
export function repoPath(p) {
  const n = posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (isAbsolute(p) || n.startsWith('../') || n === '..') throw new Error(`\`${p}\` must be a path inside the repository.`);
  return n;
}

/** Annotation-safe text: GitHub workflow commands end at a newline. */
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const tokensOf = (text) => Math.ceil(text.length / 4);

/** A fence longer than any backtick run in `text`. */
const fence = (text) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));

/**
 * Run the action.
 * @param {{ env: Record<string,string|undefined>, fetch: typeof fetch, sleep?: (ms:number)=>Promise<void>,
 *   stdout?: (s:string)=>void }} deps
 * @returns {Promise<{ ok: boolean, outputs: Record<string,string> }>}
 */
export async function run({ env, fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), stdout = (s) => process.stdout.write(s) }) {
  const log = (s) => stdout(`${s}\n`);
  const annotate = (level, title, message) => log(`::${level} title=${esc(title).replace(/:/g, '%3A').replace(/,/g, '%2C')}::${esc(message)}`);
  const inputs = readInputs(env);
  const outputs = { changed: 'false', tokens: '', path: '', 'pr-url': '', source: '', pages: '' };
  const summary = [];
  const cwd = env.GITHUB_WORKSPACE || process.cwd();
  const at = (p) => resolve(cwd, p);

  const finish = (ok) => {
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
    if (env.GITHUB_STEP_SUMMARY && summary.length) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
    return { ok, outputs };
  };

  try {
    if (!inputs.url) throw new Error('`url` is required.');
    if (!MODES.includes(inputs.mode)) throw new Error(`\`mode\` must be one of ${MODES.join(', ')}; got \`${inputs.mode}\`.`);
    if (inputs.apiKey) log(`::add-mask::${inputs.apiKey}`);
    const deps = { fetch, sleep, apiKey: inputs.apiKey, api: env.LLMS_INK_API || undefined };

    if (inputs.mode === 'check') {
      const result = await check(inputs.url, deps);
      checkSummary(inputs.url, result, summary);
      outputs.tokens = String(result.tokens);
      for (const i of result.issues) {
        const level = i.level === 'error' ? 'error' : i.level === 'warning' ? 'warning' : 'notice';
        annotate(level, `llms.txt ${i.code}${i.line ? ` (line ${i.line})` : ''}`, i.message);
      }
      for (const b of result.links.broken) annotate('error', 'llms.txt broken_link', `${b.url} (HTTP ${b.status || 'no answer'})`);
      const failed = checkFailed(result);
      log(
        `Checked ${result.url}: ${result.summary.errors} errors, ${result.summary.warnings} warnings, ` +
          `${result.links.broken.length} of ${result.links.checked} links broken.`,
      );
      return finish(!failed);
    }

    // commit and pr: check the token, paths and branch before spending quota.
    const paths = [inputs.path, ...(inputs.fullPath && inputs.mode !== 'comment' ? [inputs.fullPath] : [])];
    let gh;
    let target;
    if (inputs.mode === 'commit' || inputs.mode === 'pr') {
      for (const p of paths) repoPath(p);
      gh = gitHub({ token: inputs.token, repository: env.GITHUB_REPOSITORY ?? '', api: env.GITHUB_API_URL, fetch });
      target = await currentBranch(env, inputs, gh);
      if (inputs.mode === 'pr' && (inputs.branch || PR_BRANCH) === target)
        throw new Error(`The PR branch \`${target}\` is the branch it would merge into; set \`branch\`.`);
      // After a deploy of our own llms.txt commit (or of the merged PR), nothing else shipped: regenerating could
      // only reword the file and commit again, deploy again, and so on.
      const deployed = deployedSha(env);
      if (deployed) {
        const touched = await gh.commitFiles(deployed);
        if (touched.length && touched.every((f) => paths.map(repoPath).includes(f))) {
          log(`The deployed commit ${deployed.slice(0, 7)} only changed ${touched.join(', ')}; nothing to regenerate.`);
          summary.push(`### llms.txt for ${inputs.url}`, '', `Skipped: the deployed commit \`${deployed.slice(0, 7)}\` only changed ${touched.map((f) => `\`${f}\``).join(', ')}.`, '');
          return finish(true);
        }
      }
    }

    // Generate.
    const gen = await generate(inputs.url, { mode: 'llms', fresh: inputs.fresh, generated: inputs.generated }, deps);
    outputs.tokens = String(gen.tokens);
    outputs.source = gen.source;
    outputs.pages = String(gen.pages);
    const files = { [inputs.path]: gen.text };
    log(`Generated llms.txt (${gen.source}, ${gen.pages} links, ~${gen.tokens} tokens)`);
    if (inputs.fullPath && inputs.mode !== 'comment') {
      const full = await generate(inputs.url, { mode: 'full', fresh: inputs.fresh, generated: inputs.generated }, deps);
      files[inputs.fullPath] = full.text;
      log(`Generated llms-full.txt (${full.source}, ${full.pages} pages, ~${full.tokens} tokens)`);
    }

    const local = (p) => (existsSync(at(p)) ? readFileSync(at(p), 'utf8') : null);
    const writeAll = () => {
      for (const [p, text] of Object.entries(files)) {
        mkdirSync(dirname(at(p)), { recursive: true });
        writeFileSync(at(p), text);
        log(`Wrote ${p}`);
      }
      outputs.path = inputs.path;
    };

    // Baseline for `changed` and the section diff: the local file (write, comment) or the file on the target
    // branch (commit, pr).
    const before = {};
    for (const p of Object.keys(files)) before[p] = gh ? await gh.file(repoPath(p), target) : local(p);
    const changed = Object.entries(files).some(([p, text]) => before[p] !== text);
    outputs.changed = String(changed);
    const diff = diffSections(before[inputs.path], gen.text);
    log(before[inputs.path] == null ? `${inputs.path} is new.` : `${describeDiff(diff)} in ${inputs.path}.`);

    const facts = [
      ['Mode', `\`${inputs.mode}\``],
      ['Source', gen.source === 'native' ? 'The site’s own llms.txt (copied)' : 'Generated by llms.ink'],
      ['Tokens', `${gen.tokens}${before[inputs.path] != null ? ` (was ~${tokensOf(before[inputs.path])})` : ''}`],
      ['Sections', String(countSections(gen.text))],
      ['Links', String(gen.pages)],
    ];

    if (inputs.mode === 'write') {
      writeAll();
      facts.push(['File', `\`${inputs.path}\` ${changed ? 'updated' : 'unchanged'}`]);
    } else if (inputs.mode === 'commit') {
      writeAll();
      if (changed) {
        const parent = await gh.branchSha(target);
        if (!parent) throw new Error(`Branch \`${target}\` doesn’t exist.`);
        const sha = await gh.commit(parent, repoFiles(files), inputs.commitMessage);
        if (sha) {
          await gh.setBranch(target, sha);
          log(`Committed ${sha.slice(0, 7)} to ${target}`);
          facts.push(['Commit', `\`${sha.slice(0, 7)}\` on \`${target}\``]);
        }
      } else facts.push(['Commit', `None: \`${inputs.path}\` on \`${target}\` is current`]);
    } else if (inputs.mode === 'pr') {
      writeAll();
      const head = inputs.branch || PR_BRANCH;
      if (changed) {
        const baseSha = await gh.branchSha(target);
        const headSha = await gh.branchSha(head);
        const sha = await gh.commit(baseSha, repoFiles(files), inputs.commitMessage, headSha ? await gh.treeOf(headSha) : undefined);
        if (sha) {
          await gh.setBranch(head, sha, { force: true, exists: !!headSha });
          log(`Pushed ${sha.slice(0, 7)} to ${head}`);
        } else log(`${head} already has this llms.txt`);
        const body = prBody(inputs, gen, diff, before[inputs.path]);
        let pr = await gh.openPull(head, target);
        if (pr) await gh.updatePull(pr.number, body);
        else {
          try {
            pr = await gh.createPull(head, target, inputs.commitMessage, body);
          } catch (err) {
            if (err.status === 403)
              err.message += ' Allow it under Settings → Actions → General → “Allow GitHub Actions to create and approve pull requests”, and give the job `pull-requests: write`.';
            throw err;
          }
        }
        outputs['pr-url'] = pr.html_url;
        log(`Pull request: ${pr.html_url}`);
        facts.push(['Pull request', pr.html_url]);
      } else {
        const pr = await gh.openPull(head, target);
        if (pr) outputs['pr-url'] = pr.html_url;
        facts.push(['Pull request', `None needed: \`${inputs.path}\` on \`${target}\` is current`]);
      }
    } else {
      // comment
      const number = pullNumber(env);
      const body = commentBody(inputs, gen, diff, before[inputs.path]);
      if (!number) annotate('warning', 'llms.ink', '`mode: comment` runs on pull_request events; no comment posted.');
      else {
        try {
          gh = gitHub({ token: inputs.token, repository: env.GITHUB_REPOSITORY ?? '', api: env.GITHUB_API_URL, fetch });
          const c = await gh.stickyComment(number, marker(inputs.path), body);
          log(`Comment: ${c.html_url}`);
          facts.push(['Comment', c.html_url]);
        } catch (err) {
          // Differences never fail the job; neither does a token that can't comment (PRs from forks).
          annotate('warning', 'llms.ink', `Couldn’t comment on #${number}: ${err.message}. The job needs \`pull-requests: write\`.`);
        }
      }
    }

    summary.push(`### llms.txt for ${inputs.url}`, '', '| | |', '|---|---|', ...facts.map(([k, v]) => `| ${k} | ${v} |`), '');
    summary.push(before[inputs.path] == null ? `\`${inputs.path}\` is new.` : `${describeDiff(diff)} in \`${inputs.path}\`.`, '');
    if (before[inputs.path] != null && !diff.identical) summary.push(diffTable(diff), '');
    return finish(true);
  } catch (err) {
    const title = err instanceof LlmsInkError && err.status ? `llms.ink (${err.status})` : 'llms.ink';
    annotate('error', title, err.message);
    summary.push(`### llms.txt for ${inputs.url || '(no url)'}`, '', `Failed: ${err.message}`, '');
    return finish(false);
  }
}

const repoFiles = (files) => Object.fromEntries(Object.entries(files).map(([p, t]) => [repoPath(p), t]));
const marker = (path) => `<!-- llms-txt-action:${path} -->`;

/** The branch commit/pr mode works against: `branch` (commit mode), the pushed branch, or the default branch. */
async function currentBranch(env, inputs, gh) {
  if (inputs.mode === 'commit' && inputs.branch) return inputs.branch;
  if (env.GITHUB_HEAD_REF && inputs.mode === 'commit') return env.GITHUB_HEAD_REF;
  if (env.GITHUB_REF?.startsWith('refs/heads/')) return env.GITHUB_REF.slice('refs/heads/'.length);
  return gh.defaultBranch();
}

/** The event payload, or {} when there is none. */
function payload(env) {
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** The PR number of a pull_request / pull_request_target event, or null. */
function pullNumber(env) {
  if (!['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME)) return null;
  return payload(env).pull_request?.number ?? null;
}

/** The commit a deployment_status or workflow_run event is about, or null for other events. */
function deployedSha(env) {
  if (env.GITHUB_EVENT_NAME === 'deployment_status') return payload(env).deployment?.sha ?? null;
  if (env.GITHUB_EVENT_NAME === 'workflow_run') return payload(env).workflow_run?.head_sha ?? null;
  return null;
}

function prBody(inputs, gen, diff, before) {
  return [
    `Regenerated \`${inputs.path}\`${inputs.fullPath ? ` and \`${inputs.fullPath}\`` : ''} from ${inputs.url} with [llms.ink](https://llms.ink): ~${gen.tokens} tokens, ${countSections(gen.text)} sections, ${gen.pages} links.`,
    '',
    before == null ? `\`${inputs.path}\` is new.` : `${describeDiff(diff)}.`,
    '',
    before != null ? diffTable(diff) : '',
    '',
    'Opened by [lukax/llms-txt-action](https://github.com/lukax/llms-txt-action). Later runs update this branch and PR.',
  ].join('\n');
}

function commentBody(inputs, gen, diff, before) {
  const head = [
    marker(inputs.path),
    `### llms.txt for ${inputs.url}`,
    '',
    `[llms.ink](https://llms.ink) ${gen.source === 'native' ? 'copied the site’s own llms.txt' : 'generated llms.txt'}: **~${gen.tokens} tokens**${before != null ? ` (\`${inputs.path}\` has ~${tokensOf(before)})` : ''}, ${countSections(gen.text)} sections, ${gen.pages} links.`,
    '',
  ];
  if (before == null) head.push(`\`${inputs.path}\` isn’t in the repository yet.`);
  else if (diff.identical) head.push(`No section changes against \`${inputs.path}\`.`);
  else head.push(`${describeDiff(diff)} against \`${inputs.path}\`:`, '', diffTable(diff));
  let text = gen.text;
  const room = COMMENT_LIMIT - head.join('\n').length - 200;
  if (text.length > room) text = `${text.slice(0, Math.max(0, room))}\n… (truncated)`;
  const f = fence(text);
  return [...head, '', '<details><summary>Generated llms.txt</summary>', '', `${f}markdown`, text.trimEnd(), f, '', '</details>'].join('\n');
}

function checkSummary(url, r, summary) {
  summary.push(
    `### llms.txt check for ${url}`,
    '',
    '| | |',
    '|---|---|',
    `| File | ${r.found ? r.url : `Not found (HTTP ${r.status}) at ${r.url}`} |`,
    `| Result | ${checkFailed(r) ? 'Failed' : 'Passed'}: ${r.summary.errors} errors, ${r.summary.warnings} warnings |`,
    `| Tokens | ${r.tokens} |`,
    `| Sections | ${r.sections} |`,
    `| Links | ${r.links.total} (${r.links.checked} checked, ${r.links.broken.length} broken) |`,
    `| llms-full.txt | ${r.llmsFull ? 'Published' : 'Not published'} |`,
    '',
  );
  if (r.issues.length) {
    summary.push('| Level | Check | Line | Message |', '|---|---|---|---|');
    for (const i of r.issues) summary.push(`| ${i.level} | \`${i.code}\` | ${i.line ?? ''} | ${i.message.replace(/\|/g, '\\|')} |`);
    summary.push('');
  }
  if (r.links.broken.length) {
    summary.push('Broken links:', '', ...r.links.broken.map((b) => `- ${b.url} (HTTP ${b.status || 'no answer'})`), '');
  }
}
