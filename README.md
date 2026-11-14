# Generate llms.txt with llms.ink

A GitHub Action that writes an [llms.txt](https://llmstxt.org) for your website, docs or repo, so ChatGPT, Claude, Cursor
and other AI tools can find the pages worth reading, and keeps it current: write it before a build, commit it after a
deploy, open a weekly pull request, check the published file in CI, or comment the changes on pull requests. It calls
the free [llms.ink](https://llms.ink) API; an API key is optional.

- **Websites and docs:** a summary and sections of the most useful links, found on the page, in its sitemap and in its links.
- **GitHub repos:** the README plus every documentation file, linked as raw Markdown.
- **llms-full.txt** (optional): the same index followed by the full Markdown of up to 20 linked pages.

```yaml
- uses: lukax/llms-txt-action@v1
  with:
    url: https://example.com
    path: public/llms.txt
    full-path: public/llms-full.txt   # optional
```

## Modes

| `mode` | What it does | Fails the job when |
|---|---|---|
| `write` (default) | Writes `path` (and `full-path`) in the workspace. | llms.ink returns an error. |
| `commit` | Writes the files, then commits them to the branch the workflow runs on (or `branch`) when they changed. | llms.ink or GitHub returns an error. |
| `pr` | Writes the files, then pushes them to the branch `llms-ink/llms-txt` (or `branch`) and opens a pull request, or updates the open one. | llms.ink or GitHub returns an error. |
| `check` | Checks llms.txt (format at llmstxt.org, first 25 links): the one the site publishes, or the file at `path` in the checkout when you set `path` (see `check-target`). Writes nothing. | The file is missing, has format errors, or has broken links. Warnings don't fail. |
| `comment` | On a pull request: generates llms.txt, compares it with `path` in the repository section by section, and posts one comment (updated on every run). Writes nothing. | llms.ink returns an error. Differences never fail it. |

`commit` and `pr` work through the GitHub API, so they don't need a local `git` identity, and each run makes at most one
commit. In `pr` mode the branch is rebuilt on top of the base branch every run, so the pull request always holds one
commit.

### Permissions

| `mode` | `permissions:` | Also |
|---|---|---|
| `write` | none | `actions/checkout` if a later step builds from the file |
| `commit` | `contents: write` | |
| `pr` | `contents: write`, `pull-requests: write` | Settings → Actions → General → **Allow GitHub Actions to create and approve pull requests** |
| `check` | none | |
| `comment` | `pull-requests: write` | `actions/checkout`, to read the committed file. On pull requests from forks the token can't comment: the job warns and passes. |

Commits and pull requests made with the default `GITHUB_TOKEN` don't start other workflows (your host's own Git
integration, such as Vercel, Netlify or Cloudflare Pages, still deploys them). To start workflows, pass a personal
access token or a GitHub App token as `token`.

## Examples

### Ship llms.txt with every deploy

Generate it into your static folder before the build, so each deploy publishes a current file:

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com
          path: public/llms.txt
      - run: npm ci && npm run build
      # … your deploy step
```

The file describes the site as it is live when the job runs, so pages you add show up from the next deploy on.

### Regenerate after each deploy

Run when a deployment succeeds, so the file describes what actually shipped, and commit it to the branch that deploys.
With `deployment_status` (Vercel, Netlify, Cloudflare Pages and GitHub Pages environments all report one):

```yaml
name: llms.txt
on: deployment_status

permissions:
  contents: write

jobs:
  llms:
    if: github.event.deployment_status.state == 'success' && github.event.deployment.environment == 'Production'
    runs-on: ubuntu-latest
    steps:
      - uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com
          path: public/llms.txt
          mode: commit
          branch: main
          api-key: ${{ secrets.LLMS_INK_KEY }}
```

Or after your own deploy workflow, with `workflow_run`:

```yaml
name: llms.txt
on:
  workflow_run:
    workflows: [Deploy]
    types: [completed]
    branches: [main]

permissions:
  contents: write

jobs:
  llms:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com
          path: public/llms.txt
          mode: commit
```

The commit deploys again. On that run the action sees that the deployed commit only changed the llms.txt files and
stops without calling llms.ink, so a deploy never loops. The environment name in the first example depends on your
host (`Production` on Vercel); check it under your repository's Deployments.

### Weekly pull request

Open a pull request when the file changed, and keep updating it until someone merges it:

```yaml
name: llms.txt
on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  llms:
    runs-on: ubuntu-latest
    steps:
      - id: llms
        uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com
          path: public/llms.txt
          mode: pr
      - if: steps.llms.outputs.changed == 'true'
        run: echo "Review ${{ steps.llms.outputs.pr-url }}"
```

To commit straight to the default branch instead, use `mode: commit` with `permissions: contents: write`.

### Comment on pull requests

Show reviewers how the live site's llms.txt differs from the committed one: sections added, removed and changed, and the
token count, in one comment that each push updates:

```yaml
name: llms.txt preview
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  llms:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com
          path: public/llms.txt
          mode: comment
          fresh: false
```

`fresh: false` reuses llms.ink's copy from the last 24 hours, so busy pull requests don't spend quota on every push.

### Gate pull requests on llms.txt

With the repository checked out and `path` set, `check` mode lints that file before you deploy it: format errors
and broken links fail the pull request, with annotations on the file's lines. `url` resolves relative links and is
where llms-full.txt is looked for.

```yaml
name: Check llms.txt
on:
  pull_request:
    paths: [public/llms.txt]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com
          path: public/llms.txt
          mode: check
```

`path` is what turns this on: without it, `check` mode keeps checking the live site. `links: false` checks only the
format. `check-target: file` fails when the file is missing instead of falling back to
the site.

### Gate CI on the published llms.txt

Without `path` (or with `check-target: live`), `check` mode checks what the site publishes. Fail when it's
missing, breaks the format, or links to pages that don't load:

```yaml
name: Check llms.txt
on:
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com
          mode: check
```

Errors and warnings show up as annotations on the run, and the job summary lists every check and the file's outline
(title, summary, sections and their link counts). Checks don't count against the daily quota.

### Use an API key

Without a key, rebuilds share llms.ink's free quota of 60 new links per IP address per day, and GitHub-hosted runners
share IP addresses with everyone else's jobs. A key (`lk_…`) gives your jobs their own quota (1000 a day by default).
[Ask for one](https://lucasespindola.com/message?text=Hi+Lucas%2C+I%E2%80%99d+like+an+llms.ink+API+key+for+the+GitHub+Action+on+...), store it as a repository secret named
`LLMS_INK_KEY`, and pass it in:

```yaml
- uses: lukax/llms-txt-action@v1
  with:
    url: https://example.com
    api-key: ${{ secrets.LLMS_INK_KEY }}
```

An invalid or revoked key fails the job with `401 invalid_key`; the action never falls back to the anonymous quota.

## Inputs

| Input | Default | |
|---|---|---|
| `url` | (required) | The site, docs section, page or GitHub repo, e.g. `https://example.com` or `https://github.com/owner/repo`. |
| `path` | `llms.txt` | Where to write llms.txt. In `commit` and `pr` modes, a path inside the repository; in `comment` mode, the file to compare against; in `check` mode, the file to lint (only when set). |
| `full-path` | (empty) | Where to write llms-full.txt. Empty skips it. Not used in `check` and `comment` modes. |
| `fresh` | `true` | Rebuild instead of using llms.ink's 24-hour cache. |
| `mode` | `write` | `write`, `commit`, `pr`, `check` or `comment` (see [Modes](#modes)). |
| `api-key` | (empty) | llms.ink API key, sent as `Authorization: Bearer`. Use `${{ secrets.LLMS_INK_KEY }}`. |
| `generated` | `false` | `true` always generates and never copies the site's own llms.txt. Set it when your /llms.txt is served from llms.ink. |
| `commit-message` | `Update llms.txt` | Commit message in `commit` and `pr` modes, and the pull request title. |
| `branch` | (empty) | `commit`: the branch to commit to (default: the branch the workflow runs on, or the default branch). `pr`: the branch the pull request comes from (default: `llms-ink/llms-txt`). |
| `token` | `github.token` | Token for `commit`, `pr` and `comment`. |
| `check-target` | `auto` | `check` mode: `auto` lints the file at `path` when `path` is set and the file exists, else checks the site at `url`; `file` always lints the file at `path` (default `llms.txt`; fails when it's missing); `live` always checks the site. |
| `links` | `true` | `check` mode on a file: also check up to 25 linked URLs and llms-full.txt next to `url`. The live check always does. |

## Outputs

| Output | |
|---|---|
| `changed` | `true` when the new file differs from the previous one: the file in the workspace (`write`, `comment`) or on the branch (`commit`, `pr`). `false` in `check` mode. |
| `tokens` | Estimated tokens in llms.txt (in `check` mode, in the published file). |
| `path` | Where llms.txt was written; empty in `check` and `comment` modes. |
| `pr-url` | The pull request opened or updated in `pr` mode (or the open one when nothing changed). |
| `source` | `generated` when llms.ink wrote the file, `native` when the site publishes its own llms.txt (copied as is). |
| `pages` | Links in llms.txt. |

Use `changed` to decide whether a later step should redeploy:

```yaml
- id: llms
  uses: lukax/llms-txt-action@v1
  with:
    url: https://example.com
    path: public/llms.txt
- if: steps.llms.outputs.changed == 'true'
  run: npm run deploy
```

## Job summary

Every run adds a summary to the workflow run page: tokens (and the previous count), sections, links, the commit or pull
request it made, and a table of sections added, removed and changed. `check` mode lists the checker's result, the
outline (sections and link counts), every issue and every broken link.

## Good to know

- **The last line** of a generated file is `<!-- Generated with https://llms.ink -->`. Markdown readers don't show it.
  While it's there, llms.ink knows a published copy is its own output and regenerates it on the next run. Delete it
  once you edit the file by hand: from then on llms.ink treats the file as yours and copies it unchanged.
- **Your own llms.txt wins:** if the site already publishes one written by you, the action copies it instead of
  generating a new one. If your /llms.txt is served from llms.ink (a rewrite or proxy), set `generated: true`.
- **Limits:** without a key, each rebuild counts against llms.ink's free quota of 60 links per IP address per day,
  and GitHub-hosted runners share IP addresses. If a run fails with a quota error, add an `api-key`, set
  `fresh: false` to accept a result up to 24 hours old, or run it less often.
- **Links are real:** the model only picks from links llms.ink actually found, so it can't invent URLs. Its one-line
  descriptions can still be imperfect; review the first file before you publish it.
- **Runner:** the action runs on Node.js 20 or later, which every GitHub-hosted runner has. It has no dependencies.

Also on llms.ink: a [JSON API](https://llms.ink/docs/), an MCP server for agents (`https://llms.ink/mcp`) and a CLI
(`npx @lukax/llms-ink`).

## Development

```sh
npm test                                                     # unit tests, mocked llms.ink and GitHub APIs
node test/harness.mjs url=https://llmstxt.org mode=check     # run action.yml's step locally against llms.ink
node test/harness.mjs --mock --pr 7 mode=comment url=https://acme.test
```

The harness maps inputs (with action.yml's defaults) through the step's `env` block, sets the `GITHUB_*` files in a temp
directory, runs the step's script with bash, and prints the outputs, the job summary and the files written. `--mock`
serves llms.ink and the GitHub API from memory.

## License

MIT
