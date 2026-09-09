import type { AppLanguage } from '../shared/types'

type CommandDialogTerms = {
  title: string
  message: (duration: string) => string
  detail: (command: string, checks: string) => string
  checksNone: string
  approve: string
  deny: string
}

const en: CommandDialogTerms = {
  title: 'Command execution approval',
  message: (duration) => `Approve command execution (timeout ${duration})?`,
  detail: (command, checks) => `${command}\n\nChecks passed: ${checks}`,
  checksNone: 'none',
  approve: 'Approve',
  deny: 'Deny',
}

const zh: CommandDialogTerms = {
  title: '命令执行审批',
  message: (duration) => `申请执行命令，限时${duration}，超时截断，是否允许？`,
  detail: (command, checks) => `${command}\n\n已通过检查：${checks}`,
  checksNone: '无',
  approve: '允许',
  deny: '拒绝',
}

const terms: Record<'en' | 'zh-CN', CommandDialogTerms> = { en, 'zh-CN': zh }

/** Formats seconds as h/m/s for the approval dialog (e.g. 2小时15分钟 / 2h 15m). */
export function formatDuration(seconds: number, language: 'en' | 'zh-CN'): string {
  const zhTerms = language === 'zh-CN'
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const rest = seconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(zhTerms ? `${hours}小时` : `${hours}h`)
  if (minutes > 0) parts.push(zhTerms ? `${minutes}分钟` : `${minutes}m`)
  if (rest > 0 || parts.length === 0) parts.push(zhTerms ? `${rest}秒` : `${rest}s`)
  return parts.join(zhTerms ? '' : ' ')
}

export function commandDialogTerms(language: AppLanguage, systemLocale: string): CommandDialogTerms {
  const resolved = language === 'system'
    ? (systemLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en')
    : language
  return terms[resolved] ?? terms.en
}
