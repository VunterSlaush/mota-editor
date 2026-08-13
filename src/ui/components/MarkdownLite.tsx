import { Check, Copy } from "@phosphor-icons/react";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openExternalLink } from "../externalLink";

/**
 * UI — the app's markdown renderer (react-markdown + GitHub-flavored
 * markdown: tables, task lists, strikethrough). The source is UNTRUSTED
 * agent output, so beyond react-markdown's defaults (raw HTML ignored,
 * `javascript:` URLs stripped):
 *
 * - Links never navigate the webview; they open in the system browser.
 * - Remote images never auto-load — `![](url)` would fire a request the
 *   moment it renders, a zero-click exfiltration channel for whatever a
 *   prompt-injected agent encodes into the URL. They render as links
 *   the user must deliberately click.
 *
 * Memoized: transcripts re-render on every streamed delta, and parsing
 * is the most expensive part — finished messages must not re-parse.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

const REMARK_PLUGINS = [remarkGfm];

/** How long "Copied" stays up before the button offers itself again. */
const COPIED_MS = 1_500;

/**
 * A fenced block with a copy button — commands and snippets are there to
 * be run, and selecting one out of a scrolling transcript by hand is the
 * fiddliest thing the chat asks of you.
 *
 * The text is read back off the rendered `<pre>` rather than reassembled
 * from the markdown children: what the button copies is then exactly
 * what the eye is reading, highlighting and nesting included.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const block = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="md__block">
      <pre ref={block}>{children}</pre>
      <button
        type="button"
        className="md__copy"
        title={copied ? "Copied" : "Copy to clipboard"}
        aria-label={copied ? "Copied" : "Copy code"}
        onClick={() =>
          void navigator.clipboard
            .writeText(block.current?.textContent ?? "")
            .then(() => setCopied(true))
            .catch(() => undefined)
        }
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

const COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) openExternalLink(href);
      }}
    >
      {children}
    </a>
  ),
  img: ({ src, alt }) => {
    const url = typeof src === "string" ? src : "";
    if (/^data:image\//i.test(url)) {
      return <img src={url} alt={alt ?? ""} />;
    }
    return (
      <a
        href={url}
        className="md__blocked-image"
        title="Images from agent output don't load automatically — click to open in your browser."
        onClick={(e) => {
          e.preventDefault();
          if (url) openExternalLink(url);
        }}
      >
        [image: {alt || url || "unnamed"}]
      </a>
    );
  },
};
