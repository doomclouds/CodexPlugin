---
name: clean-gone
description: Clean up all git branches marked as [gone] (branches that have been deleted on the remote but still exist locally), including removing associated worktrees
allowed-tools: Bash(git branch:*), Bash(git worktree:*), Bash(git fetch:*)
---

## Context

- Current branch: !`git branch --show-current`
- Local branches: !`git branch -v`
- Worktrees: !`git worktree list`

## Your Task

Clean up stale local branches that have been deleted from the remote repository, including removing associated worktrees.

### Prerequisites

1. **Fetch latest remote state** (to identify [gone] branches):
   ```bash
   git fetch --prune
   ```
   This updates remote-tracking branches and marks deleted branches as [gone].

### Instructions

#### Step 1: Identify [gone] branches

List all local branches with their status:
```bash
git branch -v
```

**Note**:
- Branches with a `[gone]` status have been deleted on the remote
- Branches with a `+` prefix have associated worktrees and must have their worktrees removed before deletion
- The current branch (marked with `*`) should not be deleted

#### Step 2: List worktrees

Identify worktrees that may be associated with [gone] branches:
```bash
git worktree list
```

#### Step 3: Clean up [gone] branches

**For PowerShell (Windows)**:
```powershell
# Get all [gone] branches
$goneBranches = git branch -v | Select-String '\[gone\]' | ForEach-Object {
    $_.Line -replace '^[\*\s\+]+', '' -replace '\s+.*$', ''
}

if ($goneBranches.Count -eq 0) {
    Write-Host "No [gone] branches found. No cleanup needed."
} else {
    foreach ($branch in $goneBranches) {
        Write-Host "Processing branch: $branch"

        # Find and remove worktree if it exists
        $worktreeInfo = git worktree list | Select-String "\[$branch\]"
        if ($worktreeInfo) {
            $worktreePath = ($worktreeInfo.Line -split '\s+')[0]
            $repoRoot = git rev-parse --show-toplevel
            if ($worktreePath -and $worktreePath -ne $repoRoot) {
                Write-Host "  Removing worktree: $worktreePath"
                git worktree remove --force $worktreePath
            }
        }

        # Delete the branch (skip if it's the current branch)
        $currentBranch = git branch --show-current
        if ($branch -ne $currentBranch) {
            Write-Host "  Deleting branch: $branch"
            git branch -D $branch
        } else {
            Write-Host "  Skipping current branch: $branch"
        }
    }
}
```

**For Bash (Linux/Mac)**:
```bash
# Process all [gone] branches, removing '+' prefix if present
git branch -v | grep '\[gone\]' | sed 's/^[+* ]//' | awk '{print $1}' | while read branch; do
  echo "Processing branch: $branch"

  # Skip if it's the current branch
  current=$(git branch --show-current)
  if [ "$branch" = "$current" ]; then
    echo "  Skipping current branch: $branch"
    continue
  fi

  # Find and remove worktree if it exists
  worktree=$(git worktree list | grep "\\[$branch\\]" | awk '{print $1}')
  if [ ! -z "$worktree" ] && [ "$worktree" != "$(git rev-parse --show-toplevel)" ]; then
    echo "  Removing worktree: $worktree"
    git worktree remove --force "$worktree"
  fi

  # Delete the branch
  echo "  Deleting branch: $branch"
  git branch -D "$branch"
done
```

### Safety Checks

Before deleting branches:
- **Never delete the current branch**: Check `git branch --show-current` and skip if it matches
- **Confirm worktree removal**: Only remove worktrees that are not the main repository root
- **Verify [gone] status**: Only process branches explicitly marked as `[gone]`

### Expected Behavior

After executing these commands, you will:

- See a list of all local branches with their status
- Identify and remove any worktrees associated with [gone] branches
- Delete all branches marked as [gone] (except the current branch)
- Provide feedback on which worktrees and branches were removed

**If no branches are marked as [gone]**: Report that no cleanup was needed.
