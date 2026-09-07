Run an arena: several independent attempts at the same task, then pick a winner with evidence.

Task and optional attempt count (default 3):

$ARGUMENTS

Procedure
1. Write the task brief once. It must include the finish check, the files in scope, and the constraints. Every attempt gets the identical brief.
2. Isolate each attempt. Use a separate git worktree per attempt when the harness supports it. Otherwise give each attempt a disjoint file set or run them sequentially with a reset between. Two attempts editing one tree is not an arena.
3. Spawn the attempts as parallel sub-agents. Use different models across attempts when the harness lets you choose. Each attempt returns its diff and its finish-check output.
4. Judge with a separate sub-agent on the strongest model that did not write any attempt. The judge sees all diffs and all check outputs and ranks them on: finish check passes, least code, clearest boundaries, fewest new concepts.
5. Apply only the winner. Discard the rest and remove their worktrees.

Reply format
- The brief, verbatim.
- A table: attempt, model, lines changed, finish check result.
- The judge's ranking with one-line reasons.
- The winning diff applied, and its finish-check output.

Short declarative sentences. No long dashes.
