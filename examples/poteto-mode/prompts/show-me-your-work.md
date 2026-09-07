Write the decision log for the current task. Optional destination path:

$ARGUMENTS

If no path is given, write to a markdown file under the repo's docs or plans folder if one exists, otherwise print it in the reply.

The log records what a reviewer needs to audit the work without reading the whole conversation. Append to an existing log rather than rewriting it.

Entries, one per decision, newest last
- When: the step in the todo list.
- Decision: one sentence.
- Alternatives considered: one line each, with the reason rejected.
- Evidence: the command run and the relevant output lines, or the file:line that settled it.
- Reversibility: reversible, or what it would take to undo.

Also record
- Anything skipped, with its `skip:` reason.
- Anything unverified, stated plainly.
- Open questions for the user, each with your recommended answer.

Rules
- Facts only. No narration of effort.
- Quote outputs verbatim and trimmed. Never paraphrase a failure message.
- Short declarative sentences. No long dashes.
