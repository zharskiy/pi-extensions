type PageText = { title?: string; text: string };

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  copy: "(c)",
};

const BLOCK =
  /<\/?(?:p|div|h[1-6]|tr|br|pre|ul|ol|table|section|article|header|footer|nav|main|aside|blockquote|hr)\b[^>]*>/gi;

const BETWEEN_CELLS = /<\/t[dh]\s*>\s*<t[dh]\b[^>]*>/gi;

const codePoint = (value: number, raw: string) =>
  Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : raw;

const decodeEntities = (text: string) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (raw, hex: string) => codePoint(Number.parseInt(hex, 16), raw))
    .replace(/&#(\d+);/g, (raw, dec: string) => codePoint(Number.parseInt(dec, 10), raw))
    .replace(/&([a-z]+);/gi, (raw, name: string) => NAMED[name.toLowerCase()] ?? raw);

const collapse = (text: string) =>
  text
    .replace(/[ \t\f\v\r]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

const titleOf = (html: string) => {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match ? collapse(decodeEntities(match[1].replace(/<[^>]*>/g, " ")).replace(/\n/g, " ")) : "";

  return title === "" ? undefined : title;
};

export const readableText = (html: string): PageText => {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, "")
    .replace(/<title\b[\s\S]*?<\/title\s*>/gi, "")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(?:script|style)\b[\s\S]*$/i, "")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(BLOCK, "\n")
    .replace(BETWEEN_CELLS, " | ")
    .replace(/<[^>]*>/g, "");

  return { title: titleOf(html), text: collapse(decodeEntities(text)) };
};

const mediaType = (contentType: string) => contentType.split(";")[0].trim().toLowerCase();

const isHtml = (type: string) => type === "text/html" || type === "application/xhtml+xml";

const isPlain = (type: string) =>
  type.startsWith("text/") ||
  type === "application/json" ||
  type.endsWith("+json") ||
  type === "application/xml" ||
  type.endsWith("+xml");

export const supported = (contentType: string) => {
  const type = mediaType(contentType);

  return type === "" || isHtml(type) || isPlain(type);
};

export const assertSupported = (contentType: string) => {
  if (!supported(contentType)) {
    throw new Error(`unsupported content type ${mediaType(contentType)}`);
  }
};

export const pageText = (body: string, contentType: string): PageText => {
  const type = mediaType(contentType);

  return type === "" || isHtml(type) ? readableText(body) : { text: body.trim() };
};
