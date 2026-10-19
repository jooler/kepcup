export interface InlinePart {
  text: string;
  href?: string;
}

const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;

function allowedHref(href: string): boolean {
  return (
    href.startsWith('/') ||
    href.startsWith('#') ||
    href.startsWith('https://') ||
    href.startsWith('mailto:')
  );
}

/** Render a small subset of inline links: [label](https://…), [label](/path), [label](#id). */
export function linkParts(input: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let last = 0;
  for (const match of input.matchAll(linkRe)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: input.slice(last, index) });
    const href = match[2] ?? '';
    if (!allowedHref(href)) {
      throw new Error(`Refusing link target: ${href}`);
    }
    parts.push({ text: match[1] ?? '', href });
    last = index + match[0].length;
  }
  if (last < input.length) parts.push({ text: input.slice(last) });
  return parts;
}
