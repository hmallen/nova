// Hand-rolled RSS item extractor (Plan 4). Deliberately not a real XML
// parser: it regex-extracts <item> blocks and their <title>/<source>/<pubDate>
// children, handles CDATA sections, and decodes the five named XML entities
// plus numeric character references. That subset is enough for the feeds we
// point it at (Google News, BBC, NPR); feeds using exotic markup inside
// titles will come through slightly mangled rather than crash.

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => NAMED_ENTITIES[name]);
}

function stripCdata(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return null;
  const value = decodeEntities(stripCdata(m[1])).replace(/\s+/g, " ").trim();
  return value || null;
}

// parseRss(xml) → [{ title, source?, published? }]
export function parseRss(xml) {
  if (typeof xml !== "string") return [];
  const items = [];
  for (const block of xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []) {
    const title = extractTag(block, "title");
    if (!title) continue;
    const item = { title };
    const source = extractTag(block, "source");
    const published = extractTag(block, "pubDate");
    if (source) item.source = source;
    if (published) item.published = published;
    items.push(item);
  }
  return items;
}
