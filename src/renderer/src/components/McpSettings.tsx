import { Button, Field, Input, Select, Switch, Textarea } from '@fluentui/react-components'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { McpServerTestResult, McpStdioServerConfig } from '../../../shared/types'

type Props = {
  servers: McpStdioServerConfig[]
  onChange(next: McpStdioServerConfig[]): void
  disabled?: boolean
  projectRoot?: string
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `mcp-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createServer(overrides: Partial<McpStdioServerConfig> = {}): McpStdioServerConfig {
  return {
    id: createId(),
    name: '',
    enabled: false,
    command: '',
    args: [],
    env: {},
    cwdMode: 'project-root',
    ...overrides,
  }
}

function parseEnv(value: string): Record<string, string> {
  return Object.fromEntries(value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('=')
      return separator < 0
        ? [line, '']
        : [line.slice(0, separator).trim(), line.slice(separator + 1)]
    })
    .filter(([key]) => key !== ''))
}

function formatEnv(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')
}

export function McpSettings({ servers, onChange, disabled = false, projectRoot }: Props) {
  const { t } = useTranslation()
  const [testingId, setTestingId] = useState<string>()
  const [results, setResults] = useState<Record<string, McpServerTestResult>>({})

  const update = (id: string, patch: Partial<McpStdioServerConfig>): void => {
    onChange(servers.map((server) => server.id === id ? { ...server, ...patch } : server))
  }

  const remove = (id: string): void => {
    onChange(servers.filter((server) => server.id !== id))
    setResults((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
  }

  const test = async (server: McpStdioServerConfig): Promise<void> => {
    setTestingId(server.id)
    setResults((current) => {
      const next = { ...current }
      delete next[server.id]
      return next
    })
    try {
      const result = await window.codey.testMcpServer(server, projectRoot)
      setResults((current) => ({ ...current, [server.id]: result }))
    } catch (error) {
      setResults((current) => ({
        ...current,
        [server.id]: {
          status: 'error',
          toolNames: [],
          error: error instanceof Error ? error.message : t('mcpTestFailed'),
        },
      }))
    } finally {
      setTestingId(undefined)
    }
  }

  return (
    <section className="settings-group">
      <p className="settings-description">{t('mcpDescription')}</p>
      <p className="settings-warning" role="alert">{t('mcpSecurityWarning')}</p>
      <div className="layer-config-toolbar">
        <Button
          appearance="secondary"
          disabled={disabled}
          onClick={() => onChange([...servers, createServer({ name: 'agent-lsp', command: 'agent-lsp' })])}
        >
          {t('mcpAddAgentLsp')}
        </Button>
        <Button appearance="secondary" disabled={disabled} onClick={() => onChange([...servers, createServer()])}>
          {t('mcpAddServer')}
        </Button>
      </div>
      {servers.length === 0 && <p className="status">{t('mcpNoServers')}</p>}
      {servers.map((server) => {
        const result = results[server.id]
        return (
          <article className="mcp-server-card" key={server.id}>
            <div className="mcp-server-card-heading">
              <strong>{server.name || t('mcpUnnamedServer')}</strong>
              <Switch
                checked={server.enabled}
                disabled={disabled}
                label={t('mcpEnabled')}
                onChange={(_, data) => update(server.id, { enabled: data.checked })}
              />
            </div>
            <Field label={t('mcpName')} required>
              <Input
                disabled={disabled}
                value={server.name}
                onChange={(_, data) => update(server.id, { name: data.value })}
              />
            </Field>
            <Field label={t('mcpCommand')} hint={t('mcpCommandHint')} required>
              <Input
                disabled={disabled}
                value={server.command}
                placeholder="agent-lsp"
                onChange={(_, data) => update(server.id, { command: data.value })}
              />
            </Field>
            <Field label={t('mcpArguments')} hint={t('mcpArgumentsHint')}>
              <Textarea
                disabled={disabled}
                rows={3}
                value={server.args.join('\n')}
                onChange={(_, data) => update(server.id, { args: data.value.split(/\r?\n/).filter((arg) => arg !== '') })}
              />
            </Field>
            <Field label={t('mcpEnvironment')} hint={t('mcpEnvironmentHint')}>
              <Textarea
                disabled={disabled}
                rows={3}
                value={formatEnv(server.env)}
                onChange={(_, data) => update(server.id, { env: parseEnv(data.value) })}
              />
            </Field>
            <Field label={t('mcpWorkingDirectory')}>
              <Select
                disabled={disabled}
                value={server.cwdMode}
                onChange={(_, data) => update(server.id, { cwdMode: data.value as McpStdioServerConfig['cwdMode'] })}
              >
                <option value="project-root">{t('mcpProjectRoot')}</option>
                <option value="custom">{t('mcpCustomCwd')}</option>
              </Select>
            </Field>
            {server.cwdMode === 'custom' && (
              <Field label={t('mcpCustomCwd')} required>
                <Input
                  disabled={disabled}
                  value={server.customCwd ?? ''}
                  onChange={(_, data) => update(server.id, { customCwd: data.value })}
                />
              </Field>
            )}
            <div className="layer-config-toolbar">
              <Button
                appearance="secondary"
                disabled={disabled || testingId !== undefined || !server.command.trim() || (server.cwdMode === 'custom' && !server.customCwd?.trim())}
                onClick={() => void test(server)}
              >
                {testingId === server.id ? t('mcpTesting') : t('mcpTest')}
              </Button>
              <Button appearance="secondary" disabled={disabled || testingId === server.id} onClick={() => remove(server.id)}>
                {t('remove')}
              </Button>
            </div>
            {result && (
              <div role="status">
                <p className={result.status === 'ok' ? 'status' : 'dialog-error'}>
                  {result.status === 'ok'
                    ? t('mcpTestSuccess', {
                        name: result.serverName ?? server.name,
                        version: result.serverVersion ? ` ${result.serverVersion}` : '',
                      })
                    : t('mcpTestFailedWithError', { error: result.error ?? t('mcpTestFailed') })}
                </p>
                {result.toolNames.length > 0 && <p className="status">{t('mcpTools', { tools: result.toolNames.join(', ') })}</p>}
                {result.stderr && <pre className="prompt-content">{result.stderr}</pre>}
              </div>
            )}
          </article>
        )
      })}
    </section>
  )
}
