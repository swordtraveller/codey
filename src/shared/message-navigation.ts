export type MessageNavigationEntry = { id: string; preview: string; createdAt?: string }
export type MessageNavigationTarget = { projectId: string; conversationId: string; messageId: string }

/** A literal beginning excerpt, never a model-generated interpretation. */
export function messageNavigationPreview(content: string): string {
  const text = content.trim().replace(/\s+/gu, ' ')
  const characters = Array.from(text)
  return characters.length > 160 ? characters.slice(0, 160).join('') + '…' : text
}
