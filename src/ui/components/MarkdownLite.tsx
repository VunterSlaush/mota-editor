import { memo } from "react";
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

const COMPONENTS: Components = {
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
