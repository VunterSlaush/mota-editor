Explain how this works, from the real code, before anyone touches it:

$ARGUMENTS

Rules
- Read the actual code paths. Delegate wide searches to a sub-agent and ask it for file:line evidence, not paraphrase.
- Follow one concrete flow end to end: an entry point, every hop, the exit. Name each hop with its file and line.
- Separate what you observed from what you inferred. Mark inferences.
- Show data shapes at the boundaries: what goes in, what comes out, where it is validated.
- Name the invariants the code relies on and where they are enforced or merely assumed.
- If runtime behavior is ambiguous from the code, run it and quote the output.

Reply format
1. One paragraph: what this subsystem is for and where it lives.
2. The flow as a numbered list of hops, each with file:line.
3. Data shapes at the boundaries.
4. Invariants and where they are enforced.
5. Sharp edges: anything that would surprise someone about to change it.
6. What you did not verify.

Short declarative sentences. No long dashes. No narration of your own process.
