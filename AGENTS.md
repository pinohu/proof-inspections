# AGENTS.md

Shared operating rules for every AI agent working in this repository.

<!-- agent-workflow:start v1 -->
## Multi-agent workflow (all AI agents: Claude, Codex, Cursor, Copilot, Lovable, Meta, others)

Several AI agents work in this repo. These rules keep them from colliding. They apply to every agent, every task, no exceptions. If any other instruction in this repo conflicts with them on branching, PRs or issues, these rules win.

### 1. Start from an issue
- Before changing anything, find the GitHub Issue for the task. If none exists, open one with the **Agent task** template.
- Claim it: add the label for your agent (`agent:claude`, `agent:codex`, `agent:cursor`, `agent:copilot`, `agent:lovable`, `agent:meta`, or `agent:other`) plus `in-progress`, and comment `Claimed by <agent>. Branch: <branch>`.
- If the issue already carries another agent's label and `in-progress`, it is taken. Do not work on it. Pick another issue or comment on that one.
- One issue per branch, one branch per issue.

### 2. Work on your own branch
- Never commit or push to the default branch (`main` or `master`).
- Branch from the latest default branch: `git fetch origin && git switch -c <agent>/<issue-number>-<short-slug> origin/<default>`.
  Example: `codex/42-fix-login-redirect`. If your harness assigns you a branch name, use it and put the branch name in the issue comment.
- Before every push, rebase on the latest default branch: `git fetch origin && git rebase origin/<default>`. Resolve conflicts yourself; never force-push someone else's branch.

### 3. Don't edit files another agent is changing
- Before editing, list open PRs and the files they touch (`gh pr list`, then `gh pr diff <n> --name-only`).
- If a file you need is changed in another open agent PR, do not edit it. Comment on your issue and the other PR's issue describing what you need, mark your issue `blocked`, and wait or take another task.

### 4. Open a pull request
- Push your branch and open a PR to the default branch.
- The PR body must contain `Closes #<issue-number>` and follow the PR template.
- Keep the PR to the one issue. No drive-by changes.

### 5. Merge your own PR
- Merge only when every required check is green and the branch is up to date with the default branch. If checks fail, fix them on your branch; never skip, disable or delete a test or check to get green.
- Merge with **squash**. Then delete your branch.
- Never merge another agent's PR. Never merge if the change needs a human decision (money, billing, legal text, secrets, production data); label the issue `needs-human` and stop.

### 6. Report on the issue
- Post progress, blockers and results as comments on the issue, not only in your chat. Another agent or the owner should be able to pick up from the issue alone.
- When you stop without finishing, comment what is done, what is left, and remove `in-progress`.
- On merge the issue closes automatically through `Closes #N`.

### Labels
`agent:claude` `agent:codex` `agent:cursor` `agent:copilot` `agent:lovable` `agent:meta` `agent:other` `in-progress` `blocked` `needs-human`
<!-- agent-workflow:end -->
