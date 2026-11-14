// GitHub REST: commits through the Git Data API (no local git, credentials or identity needed), pull requests and
// sticky PR comments.

import { USER_AGENT } from './llms.mjs';

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{ token: string, repository: string, api?: string, fetch: typeof fetch }} opts
 */
export function gitHub({ token, repository, api = 'https://api.github.com', fetch }) {
  if (!token) throw new GitHubError(0, 'No GitHub token: pass `token`, or leave it at its default (github.token).');
  const [owner, repo] = repository.split('/');
  const base = `${api.replace(/\/$/, '')}/repos/${owner}/${repo}`;

  async function request(method, path, body, accept = 'application/vnd.github+json') {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      try {
        message = JSON.parse(text).message ?? text;
      } catch {}
      throw new GitHubError(res.status, `GitHub ${method} ${path}: ${res.status} ${message}`);
    }
    if (accept.endsWith('raw+json')) return res.text();
    return res.status === 204 ? null : res.json();
  }

  const ref = (branch) => `/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
  const refs = (branch) => `/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;

  return {
    owner,
    repo,
    request,

    async defaultBranch() {
      return (await request('GET', '')).default_branch;
    },

    /** Head commit sha of a branch, or null when it doesn't exist. */
    async branchSha(branch) {
      return (await request('GET', ref(branch)))?.object.sha ?? null;
    },

    /** A file's content at a ref, or null when it doesn't exist. */
    async file(path, at) {
      const p = path.split('/').map(encodeURIComponent).join('/');
      return request('GET', `/contents/${p}?ref=${encodeURIComponent(at)}`, undefined, 'application/vnd.github.raw+json');
    },

    /**
     * Commit `files` ({path: content}) on top of `parent`. Returns the new commit sha, or null when the files
     * already match `parent` (or `skipIfTree` is the resulting tree).
     */
    async commit(parent, files, message, skipIfTree) {
      const parentTree = (await request('GET', `/git/commits/${parent}`)).tree.sha;
      const tree = await request('POST', '/git/trees', {
        base_tree: parentTree,
        tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
      });
      if (tree.sha === parentTree || tree.sha === skipIfTree) return null;
      return (await request('POST', '/git/commits', { message, tree: tree.sha, parents: [parent] })).sha;
    },

    /** Files a commit changed (against its first parent); [] when the commit isn't found. */
    async commitFiles(sha) {
      return ((await request('GET', `/commits/${sha}`))?.files ?? []).map((f) => f.filename);
    },

    /** Tree sha of a commit. */
    async treeOf(sha) {
      return (await request('GET', `/git/commits/${sha}`)).tree.sha;
    },

    /** Point a branch at `sha`, creating it when missing. `force` allows a non-fast-forward move. */
    async setBranch(branch, sha, { force = false, exists = true } = {}) {
      if (exists) return request('PATCH', refs(branch), { sha, force });
      return request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
    },

    /** The open pull request from `head` into `baseBranch`, or null. */
    async openPull(head, baseBranch) {
      const q = `?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(baseBranch)}`;
      return (await request('GET', `/pulls${q}`))?.[0] ?? null;
    },

    createPull(head, baseBranch, title, body) {
      return request('POST', '/pulls', { head, base: baseBranch, title, body, maintainer_can_modify: true });
    },

    updatePull(number, body) {
      return request('PATCH', `/pulls/${number}`, { body });
    },

    /** Create or update the one comment on an issue/PR whose body contains `marker`. */
    async stickyComment(number, marker, body) {
      for (let page = 1; ; page++) {
        const list = (await request('GET', `/issues/${number}/comments?per_page=100&page=${page}`)) ?? [];
        const mine = list.find((c) => c.body?.includes(marker));
        if (mine) return request('PATCH', `/issues/comments/${mine.id}`, { body });
        if (list.length < 100) break;
      }
      return request('POST', `/issues/${number}/comments`, { body });
    },
  };
}
