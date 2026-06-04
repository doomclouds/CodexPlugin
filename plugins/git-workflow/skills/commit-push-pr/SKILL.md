---
name: commit-push-pr
description: Commit, push, and create a pull request following conventional commit format
allowed-tools: Bash(git checkout --branch:*), Bash(git add:*), Bash(git status:*), Bash(git push:*), Bash(git commit:*), Bash(gh pr create:*)
---

## Context

- Current git status: !`git status`
- Current git diff (staged and unstaged changes): !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`

## Your task

Based on the above changes, complete the full workflow: commit, push, and create a pull request.

### Instructions

#### 1. Branch Management

- **Check current branch**: If currently on `main` or `master`, create a new feature branch
- **Branch naming conventions**:
  - Feature: `feature/<description>` (e.g., `feature/game-info-optimization`)
  - Fix: `fix/<description>` (e.g., `fix/null-reference-exception`)
  - Refactor: `refactor/<description>` (e.g., `refactor/messenger-system`)
  - Use kebab-case (lowercase with hyphens)
  - Be descriptive but concise

#### 2. Create Commit

Follow the same commit message format:

- **Format**: `type: description` or `type(scope): description`
- **Types**: `feat`, `fix`, `refactor`, `test`, `docs`, `style`, `chore`
- **Guidelines**:
  - Use present tense, imperative mood
  - Start with lowercase
  - Be descriptive but concise (50-72 characters)
  - Match repository's existing commit style

#### 3. Push to Remote

- Push the branch to origin: `git push -u origin <branch-name>`
- Use `-u` flag to set upstream tracking
- If push fails, check if branch exists remotely and handle accordingly

#### 4. Create Pull Request

- **Use GitHub CLI**: `gh pr create`
- **Analyze all commits**: Review all commits in the branch (not just the latest)
- **PR Title**: Use the same format as commit messages: `type: description`
- **PR Description**: Create comprehensive description with:
  - Summary of changes (1-3 bullet points)
  - Detailed changes list
  - Test plan checklist
  - Any breaking changes or migration notes

### PR Description Template

```markdown
## Summary
Brief overview of what this PR accomplishes (1-2 sentences).

## Changes
- [Detailed change 1]
- [Detailed change 2]
- [Detailed change 3]

## Testing
- [ ] Test case 1: [Description]
- [ ] Test case 2: [Description]
- [ ] Test case 3: [Description]

## Breaking Changes
- [ ] No breaking changes
- [ ] Breaking changes: [Describe if applicable]

## Related Issues
- Closes #<issue-number>
- Related to #<issue-number>

---
*Generated with Claude Code*
```

### Execute

You have the capability to call multiple tools in a single response. You MUST do all of the above in a single message:

1. Check/create branch if needed
2. Stage and commit changes with proper message format
3. Push branch to remote
4. Create pull request with comprehensive description

Do not use any other tools or do anything else. Do not send any other text or messages besides these tool calls.
