# Agent Instructions

Repository-wide Git delivery contract for coding agents in `Alran-AI/vscode`. Follow existing README, CONTRIBUTING, package, architecture, security, and testing documentation for all project-specific requirements.

## Mandatory Git delivery workflow: worktrees, branches, commits, and pull requests

This section is authoritative for Git delivery in this repository. It supersedes earlier generic Git workflow instructions only where they conflict with the mechanics below. Repository-specific architecture, security, testing, release, attribution, code-ownership, and contribution rules remain in force.

### 1. Identify the correct base branch
- Determine the repository's actual default branch from the live GitHub repository settings or \`origin/HEAD\`. Do not assume that it is named \`main\` or \`master\`, and do not rely on stale documentation when it disagrees with the live setting.
- Use the default branch as the PR base unless the repository's contribution instructions explicitly require another target.
- Fetch the latest remote state before starting: \`git fetch origin --prune\`.

### 2. One isolated worktree and task branch per task
- Every implementation or documentation task must be performed in a dedicated Git worktree on a task-specific branch.
- Create the worktree from the latest \`origin/<default-branch>\`, for example: \`git fetch origin --prune && git worktree add ../<repo>-<task-id> -b <branch-name> origin/<default-branch>\`.
- When continuing an existing PR, create a separate worktree tracking that PR's existing head branch. Do not create a duplicate PR or switch another task's worktree underneath it.
- One independent task or agent owns one worktree and one branch. Never share a worktree or branch between independent tasks.
- Follow this repository's existing branch naming convention. If none is documented, use a short prefix such as \`feat/\`, \`fix/\`, \`docs/\` or \`chore/\` followed by a lowercase kebab-case task name.

### 3. Keep the default branch read-only
- Never implement, commit, or push directly to the default branch. Treat it as the PR target only.
- Keep each branch focused on one task. Do not include unrelated work or another agent's changes.
- Stage only explicitly selected paths. Do not use \`git add -A\`, \`git add .\`, or \`git commit -a\`.
- Use meaningful commit messages and follow all repository-specific task-ID, conventional-commit, and attribution requirements.
- Push only the task branch, for example \`git push -u origin <branch-name>\`. Never force-push or rewrite shared/public branch history.

### 4. A pull request is mandatory for every change
- Every code, test, configuration, and documentation change must be delivered through a pull request against the correct base branch. Direct pushes to the default branch are prohibited.
- If an open PR already exists for the task, update its head branch and that PR instead of opening a duplicate.
- The PR description must state the problem, implementation, scope, risks, and exact validation commands with their actual results. Never claim that a check passed unless it was run and its result verified.
- Address review feedback on the same task branch. Reply to comments with the resolution and resolve a thread only after its issue is actually fixed.

### 5. Review and merge authority
- Implementation agents must not merge their own task PRs.
- The repository owner's explicitly authorized PR-maintenance automation may independently review and merge an eligible PR. It may do so only when the latest diff has been reviewed, no blocking review threads or change requests remain, every required approval is present, all required checks are green for the exact latest head SHA, the branch is mergeable, and no unresolved security or architectural blocker exists.
- Never fabricate or dismiss a required human approval, bypass branch protection, merge around failing or pending required checks, or merge a draft PR. If a repository requires a human approval, leave the PR open for that approval.

### 6. Tool and workspace safety
- Use the repository's authorized Git, worktree, and PR tooling. Never use an alternate Git binary, manipulate Git objects directly, or bypass an actual permission boundary.
- Git operations needed for the workflow are authorized only on the task worktree and task branch. Destructive operations such as \`reset --hard\`, \`clean -fd\`, and force-push remain prohibited.
- If the runtime or permissions block a required operation, stop safely and report the exact blocker; do not work around the restriction or risk another contributor's work.
- Remove a task worktree only after its work is safely pushed and the PR is merged or the task is explicitly abandoned. Never delete unmerged work.
