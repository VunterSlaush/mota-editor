No playbook fits this, or it is too big for one. Design a bespoke plan:

$ARGUMENTS

Procedure
1. Restate the goal as an outcome the user can observe. If two readings of the goal lead to materially different work, state both and pick one with a reason.
2. Write the finish condition as a check a command or a person can run. If it cannot be checked, it is not a finish condition.
3. Delegate a read of the relevant code to a sub-agent before planning. Plans built from guesses fail at step one.
4. Split into phases. Each phase has: a one-line outcome, its own check, the playbook it will run under (Investigation, Bug fix, Feature, Refactoring, Prototype), and what it depends on.
5. Order phases so the riskiest unknown is resolved first, preferably by a Prototype phase.
6. Mark every phase as parallel-safe or sequential. Parallel phases need disjoint files or separate worktrees.
7. Name what you will not do and why.

Reply format
- Goal, one sentence.
- Finish condition, as a command or observation.
- Phases as a numbered list with outcome, check, playbook, depends-on.
- Out of scope.
- Then start phase one unless the user asked for the plan only.

Short declarative sentences. No long dashes.
