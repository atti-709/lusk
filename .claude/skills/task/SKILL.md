---
name: task
description: Work one task from the Lusk Notion backlog end to end - claim it, implement in a worktree, verify, open a PR, update Notion. Use when the owner says /task <number or Notion URL>.
argument-hint: <task number, T-number or Notion URL>
disable-model-invocation: true
---
Work the task `$ARGUMENTS` from the Tasks database (data source `collection://cf69df56-6da4-408f-b939-77a1b191a54f`, project page https://app.notion.com/p/3fc6d6c018ce81ccb597dec469e58f27). Follow the Agent Guide (https://app.notion.com/p/3fc6d6c018ce813497a9db2bbb21703e) and CLAUDE.md throughout.

1. **Find and claim.** Query the Tasks data source for the task (by its ID number, its "T<n>" prefix in the title, or fetch the URL). Read the page fully: the Acceptance property, every callout ("Review fixes" callouts are part of the spec), and the plan page it links to. Stop if Status is not Ready, or if any task in Blocked by is not Done: say which, and don't start. Otherwise set Status = In progress and Agent = the branch name you will use (`<type>/t<n>-<slug>`), with the Notion `update_properties` command.
2. **Worktree.** If you are not already in a worktree, create one with the EnterWorktree tool (branch from origin/main, named after the task). Run `npm install` there. Never touch `~/Source/Repos/lusk` directly and never check out branches in it.
3. **Plan before coding.** Write a short plan in the session (files, the check you will run for each acceptance criterion). Ask the owner only for decisions the task page marks as theirs.
4. **Implement with a check to run.** Unit tests (`npm test -w server`), typecheck (`npx tsc --noEmit -p server` and `-p client`), and for Electron-facing work the Playwright harness (`npm run test:e2e`; packaged build when binaries, paths or module resolution change). Pipeline runs (transcription, rendering, tracking) are heavy: check `pgrep -fl "transcribe.py|track_speaker|remotion"` first and never run two at once.
5. **Commit** in small Conventional Commits (`<type>(<scope>): <lowercase imperative>`); a hook rejects anything else, and pushes to main. End every commit message with the attribution line from the session's instructions.
6. **Review.** Before opening the PR, have the `reviewer` subagent check the changes against the task's acceptance text (give it the criteria and the list of changed files). Fix what it finds that is real; don't gold-plate.
7. **PR.** `git push -u origin <branch>` and `gh pr create` with a body that has: what changed, each acceptance criterion with the evidence (the command and its output, or a screenshot/contact sheet path), what is left, and the attribution line. Never merge it yourself.
8. **Notion.** Set Status = In review, PR = the PR URL, and append a short result note to the task page (what changed, how verified, what's left). Found more work? Add a Backlog task with an acceptance criterion instead of widening this one.
