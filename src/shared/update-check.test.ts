import { describe, expect, it } from 'vitest'
import { checkUpdateVersions, compareVersions, normalizeVersion } from './update-check'

describe('update version checks', () => {
  it('normalizes release tags and identifies the three update states', () => {
    expect(checkUpdateVersions('0.6.3', 'v0.6.2')).toEqual({
      status: 'ahead',
      currentVersion: '0.6.3',
      latestVersion: '0.6.2',
    })
    expect(checkUpdateVersions('0.6.2', 'v0.6.2').status).toBe('current')
    expect(checkUpdateVersions('0.6.1', 'v0.6.2')).toEqual({
      status: 'behind',
      currentVersion: '0.6.1',
      latestVersion: '0.6.2',
    })
  })

  it('compares prerelease versions using semantic-version precedence', () => {
    expect(compareVersions('0.6.2-beta.2', '0.6.2-beta.10')).toBeLessThan(0)
    expect(compareVersions('0.6.2-beta.1', '0.6.2')).toBeLessThan(0)
    expect(normalizeVersion('v0.6.2+build.5')).toBe('0.6.2')
  })

  it('rejects non-semantic release tags', () => {
    expect(() => checkUpdateVersions('0.6.2', 'latest')).toThrow('Unsupported version format')
  })
})