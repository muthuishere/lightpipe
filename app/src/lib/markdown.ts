/**
 * A deliberately small markdown renderer — no dependency, and safe by
 * construction: every character of the input is HTML-escaped FIRST, and the
 * only tags that can appear in the output are the ones this file emits. A
 * received note is untrusted input arriving over a channel with no
 * authentication, so nothing in it is ever allowed to become live markup.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeHref(url: string): string | null {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
}

function inline(src: string): string {
  let s = esc(src);
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|\W)\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    const href = safeHref(url);
    return href
      ? `<a href="${esc(href)}" target="_blank" rel="noreferrer noopener">${text}</a>`
      : text;
  });
  return s;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let fence: string | null = null;
  let fenceBuf: string[] = [];

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of lines) {
    if (fence !== null) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${esc(fenceBuf.join("\n"))}</code></pre>`);
        fence = null;
        fenceBuf = [];
      } else {
        fenceBuf.push(line);
      }
      continue;
    }
    if (/^```/.test(line)) {
      closeList();
      fence = line.slice(3).trim();
      continue;
    }
    if (/^\s*$/.test(line)) {
      closeList();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const n = h[1].length;
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList();
      out.push("<hr />");
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) {
      closeList();
      out.push(`<blockquote>${inline(bq[1])}</blockquote>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (fence !== null) out.push(`<pre><code>${esc(fenceBuf.join("\n"))}</code></pre>`);
  closeList();
  return out.join("\n");
}
