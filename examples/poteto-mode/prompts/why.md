Explain why this was built the way it is:

$ARGUMENTS

Sources, in this order
1. Architecture decision records and design docs in the repo (docs/adr, docs/, ADR-numbered files).
2. Git history: blame the relevant lines, then read the commits and any PR descriptions they reference. Delegate the log reading to a sub-agent and ask for commit hashes with one-line reasons.
3. Comments in the code that explain a why.
4. Tests that pin the behavior. A test that would fail if the design changed is a reason.

Rules
- Quote the source for every claimed reason: an ADR name, a commit hash, a file:line.
- If there is no recorded reason, say so plainly. Do not invent a rationale that sounds plausible.
- Distinguish "decided" from "accreted". Code that arrived without a decision is a candidate for change; code with an ADR behind it needs the ADR revisited first.
- Note whether the original constraints still hold. A reason that expired is worth flagging.

Reply format
1. The decision in one sentence.
2. The recorded reasons, each with its source.
3. Whether those reasons still apply.
4. What is undocumented.

Short declarative sentences. No long dashes. No fabricated citations.
