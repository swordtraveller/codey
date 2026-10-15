import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { recoverQuarantinedConversations } from '../src/main/workspace-recovery'

// Run with Codey closed. Defaults to verification only; --apply first backs up all workspace data.
async function main(): Promise<void> {
  const directory = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  if (!directory) throw new Error('Usage: tsx scripts/recover-workspace-history.ts <userData> [--apply]')
  const root = resolve(directory)
  const apply = process.argv.includes('--apply')
  const manifest = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8'))
  if (manifest.version !== 2 || !Array.isArray(manifest.projectIds)) throw new Error('Unsupported workspace manifest')
  const plans: Array<{ path: string; metadata: { id: string; conversationIds: string[] }; ids: string[] }> = []
  let skipped = 0
  for (const id of manifest.projectIds) {
    const path = join(root, 'workspace-data', 'projects', Buffer.from(id).toString('base64url'), 'project.json')
    const metadata = JSON.parse(await readFile(path, 'utf8'))
    if (metadata.id !== id || !Array.isArray(metadata.conversationIds)) throw new Error('Invalid project metadata')
    const ids = await recoverQuarantinedConversations(join(path, '..', 'conversations'), metadata.conversationIds, {
      dryRun: true, onSkip: () => { skipped++ },
    })
    if (ids.length) plans.push({ path, metadata, ids })
  }
  const count = plans.reduce((sum, plan) => sum + plan.ids.length, 0)
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', projects: plans.length, conversations: count, skipped }))
  if (!apply || !count) return
  const backup = join(root, 'history-recovery-backup-' + new Date().toISOString().replace(/[:.]/g, '-'))
  await mkdir(backup)
  await cp(join(root, 'workspace.json'), join(backup, 'workspace.json'), { errorOnExist: true, force: false })
  await cp(join(root, 'workspace-data'), join(backup, 'workspace-data'), { recursive: true, errorOnExist: true, force: false })
  console.log(JSON.stringify({ backup }))
  for (const plan of plans) {
    // Refuse stale plans rather than overwrite a concurrently edited project.
    const original = await readFile(plan.path, 'utf8')
    if (JSON.stringify(JSON.parse(original)) !== JSON.stringify(plan.metadata)) throw new Error('Project changed during recovery; close Codey and retry')
    const ids = await recoverQuarantinedConversations(join(plan.path, '..', 'conversations'), plan.metadata.conversationIds)
    if (ids.join() !== plan.ids.join()) throw new Error('Recovery candidates changed; retry')
    const metadata = { ...plan.metadata, conversationIds: [...plan.metadata.conversationIds, ...ids] }
    const temporary = plan.path + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify(metadata), { flag: 'wx' })
    await rename(temporary, plan.path)
  }
  await writeFile(join(backup, 'recovery-report.json'), JSON.stringify({ recoveredConversations: count, skipped, projects: plans.map((plan) => ({ id: plan.metadata.id, recoveredIds: plan.ids })) }, null, 2))
  console.log(JSON.stringify({ recoveredConversations: count, backup }))
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
