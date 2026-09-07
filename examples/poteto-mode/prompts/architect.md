Design this change before writing it. It crosses a boundary, so shape comes before code:

$ARGUMENTS

Procedure
1. Callers first. List every place that will call or consume the new thing and what each one actually needs. Design from usage, not from the implementation you have in mind.
2. Data shapes second. Write the types or records that cross the boundary. Make illegal states unrepresentable. Parse at the edge, trust inside.
3. Boundaries third. Name which layer owns each piece and confirm dependencies point inward. Check the project's architecture doc and its boundary rules if it has them.
4. Subtract before you add. For every new module, function, or dependency, say what existing thing you considered reusing and why it did not fit. A new dependency needs a written reason.
5. Name the alternative you rejected and the one-line reason.
6. Write the finish check: the command or observation that proves the change works on its real surface.

Reply format
- Proposed shapes as code blocks.
- A table of callers and what each needs.
- Ownership by layer.
- Rejected alternative and reason.
- Finish check.
- The first implementation step, small enough to leave the tree green.

Do not implement yet unless the user said to. Short declarative sentences. No long dashes.
