import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * UI — the app's markdown renderer (react-markdown + GitHub-flavored
 * markdown: tables, task lists, strikethrough). Safe by default: raw
 * HTML in the source is ignored, everything renders as React elements.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
