import DOMPurify from 'dompurify'
import { tasklist } from '@mdit/plugin-tasklist'
import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
}).use(tasklist, { disabled: true, label: false })

const mathMarker = /(?:```math\b|\$\$[\s\S]+?\$\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|(?:^|[^\\$])\$[^$\r\n]+\$)/m
let mathSupport: typeof import('./math') | undefined
let mathSupportPromise: Promise<typeof import('./math')> | undefined

function installKatexStyles(container: HTMLElement): void {
  if (!mathSupport) return
  queueMicrotask(() => {
    const root = container.getRootNode()
    if (!(root instanceof ShadowRoot) || root.querySelector('style[data-katex]')) return
    const style = document.createElement('style')
    style.dataset.katex = ''
    style.textContent = mathSupport?.katexStyles ?? ''
    root.prepend(style)
  })
}

function renderInto(container: HTMLElement, content: string): void {
  const fragment = DOMPurify.sanitize(markdown.render(content), {
    FORBID_TAGS: ['embed', 'form', 'iframe', 'object', 'style'],
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment
  container.replaceChildren(fragment)

  for (const link of container.querySelectorAll('a')) {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }
  for (const image of container.querySelectorAll('img')) {
    image.loading = 'lazy'
    image.decoding = 'async'
    image.referrerPolicy = 'no-referrer'
  }
  for (const table of Array.from(container.querySelectorAll('table'))) {
    const scroller = document.createElement('div')
    scroller.className = 'markdown-table-scroll'
    table.replaceWith(scroller)
    scroller.append(table)
  }
}

function loadMath(container: HTMLElement, content: string): void {
  mathSupportPromise ??= import('./math').then((support) => {
    mathSupport = support
    support.installMath(markdown)
    return support
  })
  void mathSupportPromise.then(() => {
    if (!container.isConnected) return
    installKatexStyles(container)
    try {
      renderInto(container, content)
    } catch {
      container.textContent = content
    }
  })
}

export function renderMarkdownContent(container: HTMLElement, content: string): void {
  try {
    renderInto(container, content)
  } catch {
    container.textContent = content
    return
  }

  if (mathSupport) {
    installKatexStyles(container)
  } else if (mathMarker.test(content)) {
    loadMath(container, content)
  }
}

