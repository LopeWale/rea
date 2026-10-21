/** How an HTML document referenced one script. */
export type HtmlScriptReferenceKind =
  | "script-src"
  | "modulepreload"
  | "preload";

/** One external script reference discovered in HTML markup. */
export interface DiscoveredExternalScript {
  readonly specifier: string;
  readonly discovered_by: HtmlScriptReferenceKind;
  readonly is_module: boolean;
}

/** One inline script body discovered in HTML markup. */
export interface DiscoveredInlineScript {
  readonly index: number;
  readonly text: string;
  readonly is_module: boolean;
}

/** A markup reference that is intentionally not treated as a JavaScript source. */
export interface SkippedHtmlScript {
  readonly reason:
    | "importmap"
    | "non_javascript_type"
    | "empty_source"
    | "speculation_rules";
  readonly detail: string;
}

/** Script references read from HTML markup without executing or rendering it. */
export interface HtmlScriptDiscovery {
  /** Document base used for relative specifiers: the first `<base href>` or the page URL. */
  readonly base_url: string;
  readonly external: readonly DiscoveredExternalScript[];
  readonly inline: readonly DiscoveredInlineScript[];
  readonly skipped: readonly SkippedHtmlScript[];
}

const JAVASCRIPT_TYPES = new Set([
  "",
  "module",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "text/ecmascript",
  "application/ecmascript",
  "text/jsx",
  "text/babel",
]);

const ATTRIBUTE =
  /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
const TAG_NAME = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)/u;
const SCRIPT_END = /<\/script(?=[\s>/])/giu;

const decodeEntities = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const attributes = (source: string): ReadonlyMap<string, string> => {
  const parsed = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const [, name, doubleQuoted, singleQuoted, bare] = match;
    if (name === undefined) continue;
    const key = name.toLowerCase();
    if (parsed.has(key)) continue;
    parsed.set(key, decodeEntities(doubleQuoted ?? singleQuoted ?? bare ?? ""));
  }
  return parsed;
};

interface ParsedTag {
  /** ASCII-lowercased element name. */
  readonly name: string;
  readonly closing: boolean;
  readonly attributeSource: string;
  /** Index just past the closing `>`. */
  readonly end: number;
}

/**
 * Parse one start or end tag beginning at `<`, honouring quoted attribute
 * values so a `>` inside them does not end the tag. Returns null when the text
 * is not a tag (for example a bare `<` in prose) or the tag never closes.
 */
const parseTag = (html: string, start: number): ParsedTag | null => {
  const match = TAG_NAME.exec(html.slice(start, start + 64));
  if (match === null) return null;
  const closing = match[1] === "/";
  const name = (match[2] ?? "").toLowerCase();
  let index = start + match[0].length;
  let quote: '"' | "'" | null = null;
  for (; index < html.length; index += 1) {
    const character = html[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") break;
  }
  if (index >= html.length) return null;
  return {
    name,
    closing,
    attributeSource: html.slice(start + match[0].length, index),
    end: index + 1,
  };
};

/** End of a comment opened at `start`, including the abrupt `<!-->` and `<!--->` forms. */
const commentEnd = (html: string, start: number): number => {
  const body = start + 4;
  if (html.startsWith(">", body)) return body + 1;
  if (html.startsWith("->", body)) return body + 2;
  const close = html.indexOf("-->", body);
  return close === -1 ? html.length : close + 3;
};

interface ScriptElement {
  readonly attributeSource: string;
  readonly body: string;
}

interface MarkupScan {
  readonly scripts: readonly ScriptElement[];
  /** Attribute sources of `<link>` start tags outside script elements and comments. */
  readonly links: readonly string[];
  /** Attribute sources of `<base>` start tags outside script elements and comments. */
  readonly bases: readonly string[];
}

/** Consume a script element's raw-text body up to its end tag; returns the index after that end tag. */
const scriptEnd = (
  html: string,
  bodyStart: number,
): { readonly bodyEnd: number; readonly end: number } => {
  SCRIPT_END.lastIndex = bodyStart;
  const close = SCRIPT_END.exec(html);
  if (close === null) return { bodyEnd: html.length, end: html.length };
  const tag = parseTag(html, close.index);
  return {
    bodyEnd: close.index,
    end: tag === null ? html.length : tag.end,
  };
};

/**
 * Walk the document once as a tokenizer would: comments and bogus comments are
 * skipped, tags are parsed with quote-aware attribute scanning so markup inside
 * attribute values is never mistaken for a tag, and script bodies are raw text
 * where `<!--` and `<link>` are content. Indices always refer to the original
 * string, so non-ASCII text cannot skew them.
 */
const scanMarkup = (html: string): MarkupScan => {
  const scripts: ScriptElement[] = [];
  const links: string[] = [];
  const bases: string[] = [];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) break;
    if (html.startsWith("<!--", open)) {
      index = commentEnd(html, open);
      continue;
    }
    if (html.startsWith("<!", open) || html.startsWith("<?", open)) {
      const close = html.indexOf(">", open);
      index = close === -1 ? html.length : close + 1;
      continue;
    }
    const tag = parseTag(html, open);
    if (tag === null) {
      index = open + 1;
      continue;
    }
    if (tag.closing) {
      index = tag.end;
      continue;
    }
    if (tag.name === "script") {
      const { bodyEnd, end } = scriptEnd(html, tag.end);
      scripts.push({
        attributeSource: tag.attributeSource,
        body: html.slice(tag.end, bodyEnd),
      });
      index = end;
      continue;
    }
    if (tag.name === "link") links.push(tag.attributeSource);
    else if (tag.name === "base") bases.push(tag.attributeSource);
    index = tag.end;
  }
  return { scripts, links, bases };
};

const documentBase = (bases: readonly string[], pageUrl: string): string => {
  for (const source of bases) {
    const href = attributes(source).get("href")?.trim();
    if (href === undefined || href === "") continue;
    try {
      return new URL(href, pageUrl).href;
    } catch (cause: unknown) {
      // An unresolvable <base href> leaves the page URL as the document base.
      void cause;
      return pageUrl;
    }
  }
  return pageUrl;
};

type ScriptTagClassification =
  | { readonly kind: "skip"; readonly skipped: SkippedHtmlScript }
  | { readonly kind: "external"; readonly script: DiscoveredExternalScript }
  | {
      readonly kind: "inline";
      readonly text: string;
      readonly is_module: boolean;
    }
  | { readonly kind: "empty" };

const classifyScriptTag = (element: ScriptElement): ScriptTagClassification => {
  const attrs = attributes(element.attributeSource);
  const type = (attrs.get("type") ?? "").trim().toLowerCase();
  if (type === "importmap")
    return {
      kind: "skip",
      skipped: {
        reason: "importmap",
        detail:
          "An import map was declared; bare specifiers it would resolve remain unknown.",
      },
    };
  if (type === "speculationrules")
    return {
      kind: "skip",
      skipped: { reason: "speculation_rules", detail: type },
    };
  if (!JAVASCRIPT_TYPES.has(type))
    return {
      kind: "skip",
      skipped: { reason: "non_javascript_type", detail: type },
    };
  const isModule = type === "module";
  const src = attrs.get("src");
  if (src !== undefined)
    return src.trim() === ""
      ? {
          kind: "skip",
          skipped: { reason: "empty_source", detail: '<script src="">' },
        }
      : {
          kind: "external",
          script: {
            specifier: src.trim(),
            discovered_by: "script-src",
            is_module: isModule,
          },
        };
  return element.body.trim() === ""
    ? { kind: "empty" }
    : { kind: "inline", text: element.body, is_module: isModule };
};

const preloadedScripts = (
  links: readonly string[],
): readonly DiscoveredExternalScript[] => {
  const preloaded: DiscoveredExternalScript[] = [];
  for (const source of links) {
    const attrs = attributes(source);
    const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/u);
    const href = attrs.get("href")?.trim();
    if (href === undefined || href === "") continue;
    if (rel.includes("modulepreload"))
      preloaded.push({
        specifier: href,
        discovered_by: "modulepreload",
        is_module: true,
      });
    else if (
      rel.includes("preload") &&
      (attrs.get("as") ?? "").toLowerCase() === "script"
    )
      preloaded.push({
        specifier: href,
        discovered_by: "preload",
        is_module: false,
      });
  }
  return preloaded;
};

/**
 * Discover `<script src>`, inline `<script>` bodies, and `<link
 * rel="modulepreload">` or `<link rel="preload" as="script">` references from
 * HTML markup. This is a conservative markup scan: it neither renders nor
 * executes, so scripts injected at runtime are not represented, and import
 * maps are reported as skipped. Scripts inside `<template>` or `<noscript>`
 * are reported like any other, which may over-count on such pages.
 */
export const discoverHtmlScripts = (
  html: string,
  pageUrl: string,
): HtmlScriptDiscovery => {
  const { scripts, links, bases } = scanMarkup(html);
  const external: DiscoveredExternalScript[] = [];
  const inline: DiscoveredInlineScript[] = [];
  const skipped: SkippedHtmlScript[] = [];
  for (const element of scripts) {
    const classified = classifyScriptTag(element);
    if (classified.kind === "skip") skipped.push(classified.skipped);
    else if (classified.kind === "external") external.push(classified.script);
    else if (classified.kind === "inline")
      inline.push({
        index: inline.length,
        text: classified.text,
        is_module: classified.is_module,
      });
  }
  external.push(...preloadedScripts(links));
  return {
    base_url: documentBase(bases, pageUrl),
    external,
    inline,
    skipped,
  };
};
