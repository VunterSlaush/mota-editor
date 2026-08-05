import { Fragment } from "react";
import { splitCommands } from "../../core/entities/command";

interface Props {
  text: string;
  /** Lowercased command names, from `commandNames`. */
  commands: ReadonlySet<string>;
}

/**
 * UI — prompt text with its slash commands picked out, so a command
 * reads as a command wherever it appears: in the composer, in the sent
 * bubble, in the pinned prompt, in the queue.
 */
export function CommandText({ text, commands }: Props) {
  return (
    <>
      {splitCommands(text, commands).map((segment, index) =>
        segment.command ? (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are a positional split of one string — position is the identity
            key={index}
            className="cmd-token"
          >
            {segment.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: as above
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}
