type TextNode = { nodeType: number; textContent: string | null; childNodes?: ArrayLike<TextNode>; nodeName?: string };

const ignoredTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "NAV", "FOOTER", "FORM", "ASIDE", "HEADER"]);
const blockTags = new Set(["P", "DIV", "SECTION", "ARTICLE", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "PRE", "BR"]);

function walk(node: TextNode, listItem = false): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  const tagName = node.nodeName?.toUpperCase() ?? "";
  if (ignoredTags.has(tagName)) return "";
  const children = node.childNodes ? Array.from(node.childNodes, (child) => walk(child, tagName === "LI")) : [];
  const content = children.join("");
  if (tagName === "BR") return "\n";
  if (blockTags.has(tagName)) return `${tagName === "LI" ? "- " : ""}${content}\n\n`;
  return listItem ? content : content;
}

export function normalizeContentText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
    .slice(0, 500_000);
}

export function htmlToText(root: TextNode): string {
  return normalizeContentText(walk(root));
}
