---
name: commit
description: Create a git commit with automatically generated commit message following conventional commit format
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*)
---

## Context

- Current git status: !`git status`
- Current git diff (staged and unstaged changes): !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`

## Your task

Based on the above changes, create a single git commit following the repository's commit message conventions.

### Commit Message Format

Follow **Conventional Commits** format: `type: description`

#### Commit Types

- **feat**: New feature or functionality
  - Example: `feat: add SystemStatus property to MainViewModel`
- **fix**: Bug fix
  - Example: `fix: resolve null reference exception in GameService`
- **refactor**: Code refactoring without changing functionality
  - Example: `refactor: update PlayerMoveAppliedMessage to use friendly prompts`
- **test**: Test-related changes
  - Example: `test: verify all game info prompts display correctly`
- **docs**: Documentation changes
  - Example: `docs: update API documentation`
- **style**: Code style changes (formatting, whitespace, etc.)
  - Example: `style: format code with dotnet format`
- **chore**: Maintenance tasks, dependency updates
  - Example: `chore: update NuGet packages`

#### Scope (Optional)

Scope is optional but recommended for clarity:
- `feat(viewmodel): add SystemStatus property`
- `refactor(ui): update ChessBoardPage layout`

#### Description Guidelines

1. **Use present tense**: "Add feature" not "Added feature"
2. **Be descriptive but concise**: 50-72 characters for the subject line
3. **Start with lowercase**: "add feature" not "Add feature"
4. **No period at the end**: "add feature" not "add feature."
5. **Focus on what and why**: Explain what changed and why, not how
6. **Use imperative mood**: "Update" not "Updates" or "Updated"

### Instructions

1. **Analyze changes**:
   - Review both staged and unstaged changes using `git diff HEAD`
   - Examine recent commit messages to match repository's style
   - Identify the type of changes (feature, fix, refactor, etc.)
   - Determine if scope is needed for clarity

2. **Create commit message**:
   - Draft message following format: `type: description` or `type(scope): description`
   - Match the repository's existing commit style
   - Use present tense, imperative mood, lowercase start
   - Keep description concise (50-72 characters)

3. **Safety checks**:
   - Avoid committing files with secrets (.env, credentials.json, etc.)
   - Don't commit build artifacts, temporary files, or IDE-specific files
   - Check `.gitignore` to ensure files should be committed

4. **Execute**:
   - Stage files: `git add <files>` (use specific file paths, not `.` unless intentional)
   - Create commit: `git commit -m "<message>"`
   - You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. Do not use any other tools or do anything else. Do not send any other text or messages besides these tool calls.
