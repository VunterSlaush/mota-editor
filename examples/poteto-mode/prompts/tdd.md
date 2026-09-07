Do this test-first. Target:

$ARGUMENTS

Procedure
1. Find the project's test runner and the closest existing test file to the code in question. Match its style.
2. Write one failing test that encodes the bug or the missing behavior. It must fail for the right reason. Run it and quote the failure.
3. Commit or stage the failing test on its own when the repo's workflow allows it, so history shows the repro before the fix.
4. Write the smallest change that makes the test pass. No belt-and-suspenders. No unrelated cleanup.
5. Run the whole relevant test suite. Quote the summary line.
6. If the bug was seen on a real surface (UI, CLI, API), verify there too. A unit test proves the branch, not the absence of the bug.

Reply format
- The test, as a code block.
- The failing output, verbatim, trimmed.
- The fix, as a diff or a code block.
- The passing output, verbatim, trimmed.
- Surface verification, or a plain statement that it was not done and why.

Short declarative sentences. No long dashes.
