# Generate llms.txt with llms.ink

A GitHub Action that writes an [llms.txt](https://llmstxt.org) for your website, docs or repo, so ChatGPT, Claude, Cursor
and other AI tools can find the pages worth reading. It calls the free [llms.ink](https://llms.ink) API: no key, no signup.

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

### Keep llms.txt committed in your repo

Regenerate it every week and commit it when it changes:

```yaml
name: llms.txt
on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:

permissions:
  contents: write

jobs:
  llms:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: lukax/llms-txt-action@v1
        with:
          url: https://github.com/${{ github.repository }}
      - run: |
          git add llms.txt
          git diff --cached --quiet && exit 0
          git -c user.name=github-actions -c user.email=github-actions@users.noreply.github.com commit -m 'Update llms.txt'
          git push
```

## Inputs

| Input | Default | |
|---|---|---|
| `url` | (required) | The site, docs section, page or GitHub repo, e.g. `https://example.com` or `https://github.com/owner/repo`. |
| `path` | `llms.txt` | Where to write llms.txt. |
| `full-path` | (empty) | Where to write llms-full.txt. Empty skips it. |
| `fresh` | `true` | Rebuild instead of using llms.ink's 24-hour cache. |

## Outputs

| Output | |
|---|---|
| `source` | `generated` when llms.ink wrote the file, `native` when the site publishes its own llms.txt (copied as is). |
| `pages` | Links in llms.txt. |
| `tokens` | Estimated tokens in llms.txt. |

## Good to know

- **The last line** of a generated file is `<!-- Generated with https://llms.ink -->`. Markdown readers don't show it.
  While it's there, llms.ink knows a published copy is its own output and regenerates it on the next run. Delete it
  once you edit the file by hand: from then on llms.ink treats the file as yours and copies it unchanged.
- **Your own llms.txt wins:** if the site already publishes one written by you, the action copies it instead of
  generating a new one.
- **Limits:** each rebuild counts against llms.ink's free quota of 60 links per IP address per day, and GitHub-hosted
  runners share IP addresses. If a run fails with a quota error, set `fresh: false` to accept a result up to 24 hours
  old, or run it less often.
- **Links are real:** the model only picks from links llms.ink actually found, so it can't invent URLs. Its one-line
  descriptions can still be imperfect; review the first file before you publish it.

Also on llms.ink: a [JSON API](https://llms.ink/docs/), an MCP server for agents (`https://llms.ink/mcp`) and a CLI
(`npx @lukax/llms-ink`).

## License

MIT
