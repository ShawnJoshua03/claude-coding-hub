import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

export function scanLinks(path: string) {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Links/junctions are unsupported in worker workspaces: ${path}`);
  if (lstatSync(path).isDirectory()) for (const entry of readdirSync(path)) scanLinks(join(path, entry));
}
export function fixtureRoot(root: string, requested: string) {
  scanLinks(root);
  const allowed = realpathSync(root), actual = realpathSync(requested);
  if (actual.toLowerCase() !== allowed.toLowerCase()) throw new Error('Only the dedicated pilot fixture is allowed');
  return actual;
}
const inside = (parent: string, child: string) => { const r = relative(parent.toLowerCase(), child.toLowerCase()); return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r)); };

export type Workspace = { id: string; path: string; branch: string; base: string; gitDir: string };

// One git worktree + branch per task. The worker runs sandboxed inside `path`, so everything in it,
// including its `.git` pointer file, .gitattributes and any hooks directory a repo config points
// into, is worker-controlled. The hub runs git UNSANDBOXED, so every host-side git call:
// - uses the gitdir recorded at creation (before the worker ran), never discovery via `.git`;
// - disables hooks and fsmonitor, and diff drivers/textconv, so no worker-written program runs.
export class Workspaces {
  private constructor(readonly repo: string, readonly root: string, readonly commonDir: string, private readonly noHooks: string) {}
  static async open(repoPath: string, rootPath: string) {
    const repo = realpathSync(repoPath);
    mkdirSync(rootPath, { recursive: true }); const root = realpathSync(rootPath);
    const top = realpathSync((await git(['-C', repo, 'rev-parse', '--show-toplevel'])).trim());
    if (top.toLowerCase() !== repo.toLowerCase()) throw new Error('HUB_REPO_ROOT must be the top level of a git repository');
    if (inside(repo, root) || inside(root, repo)) throw new Error('Worktree root must be outside the target repository');
    const commonDir = realpathSync(join(repo, (await git(['-C', repo, 'rev-parse', '--git-common-dir'])).trim()));
    const noHooks = join(root, '.no-hooks'); mkdirSync(noHooks, { recursive: true });
    return new Workspaces(repo, root, commonDir, noHooks);
  }
  private safe(args: string[]) { return ['-c', `core.hooksPath=${this.noHooks}`, '-c', 'core.fsmonitor=false', ...args]; }
  private host(ws: Workspace, args: string[]) { return git(this.safe(['--git-dir', ws.gitDir, '--work-tree', ws.path, ...args]), ws.path); }

  async create(): Promise<Workspace> {
    const id = randomUUID().slice(0, 12), branch = `hub/${id}`, target = join(this.root, id);
    const base = (await git(this.safe(['-C', this.repo, 'rev-parse', '--verify', 'HEAD^{commit}']))).trim();
    await git(this.safe(['-C', this.repo, 'worktree', 'add', '-b', branch, target, base]));
    const path = realpathSync(target);
    try {
      scanLinks(path);
      // Recorded now, while the worktree is still exactly what git checked out.
      const gitDir = realpathSync((await git(this.safe(['-C', path, 'rev-parse', '--absolute-git-dir']))).trim());
      if (!inside(join(this.commonDir, 'worktrees'), gitDir)) throw new Error('Worktree gitdir is outside the repository');
      return { id, path, branch, base, gitDir };
    } catch (e) { await this.forceRemove(target, branch); throw e; }
  }
  async diff(ws: Workspace, maxChars = 60000) {
    await this.host(ws, ['add', '-A']);
    const stat = await this.host(ws, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--stat', ws.base]);
    const patch = await this.host(ws, ['diff', '--cached', '--no-ext-diff', '--no-textconv', ws.base]);
    return { branch: ws.branch, base: ws.base, stat: stat.trim(), patch: patch.slice(0, maxChars), truncated: patch.length > maxChars };
  }
  // Commits the worker's changes to its own branch only; nothing is merged or checked out in the repo.
  async commit(ws: Workspace, message: string) {
    await this.host(ws, ['add', '-A']);
    const changed = await this.host(ws, ['diff', '--cached', '--name-only']);
    if (!changed.trim()) return { committed: false, branch: ws.branch, sha: (await this.host(ws, ['rev-parse', 'HEAD'])).trim() };
    await this.host(ws, ['commit', '--no-verify', '-q', '-m', message]);
    return { committed: true, branch: ws.branch, sha: (await this.host(ws, ['rev-parse', 'HEAD'])).trim(), files: changed.trim().split('\n') };
  }
  async remove(ws: Workspace, opts: { discardUncommitted: boolean; deleteBranch: boolean }) {
    // A link planted by the worker must not make recursive deletion follow it out of the worktree.
    scanLinks(ws.path);
    await this.host(ws, ['add', '-A']);
    const dirty = (await this.host(ws, ['diff', '--cached', '--name-only', 'HEAD'])).trim();
    if (dirty && !opts.discardUncommitted) throw new Error(`Workspace has uncommitted changes (${dirty.split('\n').length} files). Commit them or explicitly discard.`);
    await git(this.safe(['-C', this.repo, 'worktree', 'remove', '--force', ws.path]));
    if (opts.deleteBranch) await git(this.safe(['-C', this.repo, 'branch', '-D', ws.branch]));
    return { removed: true, branchDeleted: opts.deleteBranch, branch: ws.branch };
  }
  private async forceRemove(path: string, branch: string) {
    await git(this.safe(['-C', this.repo, 'worktree', 'remove', '--force', path])).catch(() => {});
    await git(this.safe(['-C', this.repo, 'branch', '-D', branch])).catch(() => {});
  }
}

function git(args: string[], cwd?: string) {
  return new Promise<string>((resolve, reject) => execFile('git', args, { cwd, windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
    (e, stdout, stderr) => e ? reject(new Error(`git ${args.filter(a => !a.startsWith('core.')).slice(0, 6).join(' ')} failed: ${String(stderr || e.message).trim().slice(0, 500)}`)) : resolve(stdout)));
}
