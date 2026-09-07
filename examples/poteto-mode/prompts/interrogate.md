Interrogate this with adversarial review. Target (default: the current uncommitted diff):

$ARGUMENTS

Procedure
1. Spawn two or three reviewer sub-agents in parallel. Use a different model than the one that wrote the code whenever the harness allows. Each reviewer gets the same target and one lens:
   - Correctness: find a concrete input or state that produces wrong output or a crash. Every finding needs a failure scenario.
   - Design: boundary violations, leaked decisions, illegal states that the types allow, code that should have been deleted instead of added.
   - Verification: is the evidence of working real? Does the test prove the behavior or merely exercise it? Was it verified on the real surface?
2. Reviewers report findings only. No praise, no summaries of what the code does.
3. Verify each finding yourself or with a fresh sub-agent. A finding survives only when you can reproduce the failure scenario or point at the exact line that breaks the rule. Drop the rest.
4. Rank the survivors by severity.

Reply format
- Confirmed findings, most severe first. Each one: file:line, the defect in one sentence, the failure scenario, the suggested fix.
- Dropped findings in one line each with the reason they did not hold.
- Verdict: ship, fix first, or redesign.

Do not fix anything unless the user asked. Short declarative sentences. No long dashes.
