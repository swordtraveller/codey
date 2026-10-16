/** Conservative message fallback based on observed billing errors, not vendor code guesses.
 * Apply only to failed model-call events. Unknown quotas and rate limits stay failures.
 */
export function isBillingQuotaFailure(reason: string | undefined): boolean {
  if (!reason) return false
  const message = reason.normalize('NFKC').toLowerCase()
  if (/(?:^|[\s:：,，。;；\]】])用户额度不足(?=$|[\s,，。:：;；])/.test(message)) return true
  if (/(?:^|[\s:：,，。;；\]】])当前凭证的可用额度已用完(?=$|[\s,，。:：;；])/.test(message)) return true

  // Monetary evidence distinguishes these quota errors from token/context limits.
  const precharge = message.match(/预扣费额度失败[,，]\s*用户剩余额度:\s*\$\s*(-?\d+(?:\.\d+)?)[,，]\s*需要预扣费额度:\s*\$\s*(\d+(?:\.\d+)?)/)
  const tokenQuota = message.match(/\btoken quota is not enough[,，]\s*token remain quota:\s*\$\s*(-?\d+(?:\.\d+)?)[,，]\s*need quota:\s*\$\s*(\d+(?:\.\d+)?)/)
  const amounts = precharge ?? tokenQuota
  return amounts !== null && Number(amounts[1]) < Number(amounts[2])
}
