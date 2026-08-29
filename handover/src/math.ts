import { katex } from '@mdit/plugin-katex'
import type { MarkdownIt } from 'markdown-it'
import katexStyles from 'katex/dist/katex.min.css?inline'

let installed = false

export function installMath(markdown: MarkdownIt): void {
  if (installed) return
  markdown.use(katex, {
    delimiters: 'all',
    mathFence: true,
    output: 'htmlAndMathml',
    strict: 'ignore',
    throwOnError: false,
  })
  installed = true
}

export { katexStyles }
