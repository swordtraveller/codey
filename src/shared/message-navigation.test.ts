import { expect, it } from 'vitest'
import { messageNavigationPreview } from './message-navigation'
it('keeps literal opening text, normalizes whitespace and truncates without splitting emoji', () => {
  expect(messageNavigationPreview('  第一行\n  第二行\t正文 ')).toBe('第一行 第二行 正文')
  expect(messageNavigationPreview('🍎'.repeat(161))).toBe('🍎'.repeat(160) + '…')
  expect(messageNavigationPreview('   ')).toBe('')
})
