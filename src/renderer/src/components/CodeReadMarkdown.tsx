import { useMemo, type ReactNode } from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parseCodeReadReference } from '../../../shared/code-reading-reference'
import { splitArchitectureBlocks } from '../../../shared/architecture'
import { ArchitectureBlock, type CodeReadOwner } from './ArchitectureBlock'

const markdownPlugins = [remarkGfm]

function CodeReadLink({
  href,
  children,
  projectId,
  conversationId,
  messageId,
}: {
  href?: string
  children?: ReactNode
  projectId?: string
  conversationId?: string
  messageId?: string
}): React.JSX.Element {
  const codeReference = href && parseCodeReadReference(href)
  if (!codeReference || !projectId || !conversationId || !messageId) return <a href={href}>{children}</a>
  return <a href={href} onClick={(event) => {
    event.preventDefault()
    void window.codey.openCodeRead(projectId, conversationId, messageId, href).catch((error) => {
      window.alert(`Unable to open code snapshot: ${String(error)}`)
    })
  }}>{children}</a>
}


export function CodeReadMarkdown({ content, projectId, conversationId, messageId }: { content: string } & CodeReadOwner): React.JSX.Element {
  const contentBlocks = useMemo(() => splitArchitectureBlocks(content), [content])
  return <div className="markdown-content">
    {contentBlocks.map((block, index) => block.kind === 'architecture'
      ? <ArchitectureBlock key={index} content={block.content} projectId={projectId} conversationId={conversationId} messageId={messageId} />
      : <Markdown key={index} remarkPlugins={markdownPlugins} urlTransform={(url) => parseCodeReadReference(url) ? url : defaultUrlTransform(url)} components={{ a: ({ href, children }) => <CodeReadLink href={href} projectId={projectId} conversationId={conversationId} messageId={messageId}>{children}</CodeReadLink> }}>{block.content}</Markdown>)}
  </div>
}
