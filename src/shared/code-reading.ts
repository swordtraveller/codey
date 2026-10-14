import { formatCodeReadReference, parseCodeReadReference, type CodeReadReference } from './code-reading-reference'
import { architectureSourceReference, parseArchitecture, splitArchitectureBlocks } from './architecture'
export * from './code-reading-reference'

/** Finds the source links emitted in a completed assistant message. */
export function findCodeReadReferences(content: string): Array<{ sourceLink: string; reference: CodeReadReference }> {
  const matches = content.match(/codey:\/\/coderead\/text[^\s<>)\]"']*/gu) ?? []
  const found = new Map<string, CodeReadReference>()
  for (const match of matches) {
    const reference = parseCodeReadReference(match)
    if (!reference) continue
    const sourceLink = formatCodeReadReference(reference)
    found.set(sourceLink, reference)
  }
  for (const block of splitArchitectureBlocks(content)) {
    if (block.kind !== 'architecture') continue
    const result = parseArchitecture(block.content)
    if (!result.ok) continue
    for (const node of result.graph.nodes) {
      if (!node.source) continue
      const reference = architectureSourceReference(node.source)
      found.set(formatCodeReadReference(reference), reference)
    }
  }
  return [...found].map(([sourceLink, reference]) => ({ sourceLink, reference }))
}

export const codeReadLinkPrompt = [
  'When citing project code in your final answer, use a Markdown link in this exact form:',
  '[label](codey://coderead/text?root=<folder-id>&path=<relative-posix-path>#L<start>-L<end>).',
  'Use a folder id from the project-folder list, URL-encode values, and use 1-based inclusive lines.',
  'Only cite files you actually inspected. These links open an immutable Codey snapshot captured when your response is saved.',
].join(' ')
