import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '.',
  },
}))

import {
  createSkillTools,
  githubSkillTrackingUrl,
  normalizeInstalledSkills,
  parseGitHubSkillUrl,
  previewGitHubSkill,
  resolveSkillSelection,
  runSkillTool,
  sanitizeResourceSelection,
  skillInstructions,
  stableSkillId,
  validateResourceSelection,
} from '../src/main/skills'
import type { InstalledSkill, Project } from '../src/shared/types'

const project: Project = {
  id: 'project',
  name: 'Project',
  archived: false,
  defaultModelConfigId: null,
  contextConfigOverride: null,
  commandExecutionDefault: null,
  agentLimitsDefault: null,
  skillSelection: { enabledIds: [], disabledIds: [] },
  knowledgeBaseSelection: { enabledIds: [], disabledIds: [] },
  folders: [
    { id: 'folder-a', path: 'D:\\project-a' },
    { id: 'folder-b', path: 'D:\\project-b' },
  ],
  pythonEnvironmentFolderId: null,
  conversations: [],
}

function installedSkill(overrides: Partial<InstalledSkill> = {}): InstalledSkill {
  return {
    id: 'github:owner/repo:',
    name: 'Demo',
    description: 'Demo skill',
    sourceUrl: 'https://github.com/owner/repo',
    sourceOwner: 'owner',
    sourceRepo: 'repo',
    sourcePath: '',
    sourceCommitSha: 'a'.repeat(40),
    packageSha256: 'b'.repeat(64),
    installedAt: '2026-09-17T00:00:00.000Z',
    instructions: '# Demo\nDo the thing.',
    tools: [
      {
        id: 'run-demo',
        name: 'Run Demo',
        description: 'Runs the demo script.',
        runtime: 'node',
        entry: 'scripts/run.mjs',
        timeoutMs: 30_000,
      },
    ],
    ...overrides,
  }
}

describe('GitHub skill source parsing', () => {
  it('parses repository URLs and strips a .git suffix', () => {
    expect(parseGitHubSkillUrl('https://github.com/Owner/Repo.git')).toEqual({
      owner: 'Owner',
      repo: 'Repo',
      ref: null,
      path: '',
      canonicalUrl: 'https://github.com/Owner/Repo',
    })
  })

  it('preserves a tree tail for network-time ref/path resolution', () => {
    expect(parseGitHubSkillUrl('https://github.com/owner/repo/tree/main/path/to/skill')).toEqual({
      owner: 'owner',
      repo: 'repo',
      ref: 'main/path/to/skill',
      path: '',
      canonicalUrl: 'https://github.com/owner/repo',
    })
  })

  it('keeps a tracking URL instead of replacing a branch with a commit SHA', () => {
    expect(githubSkillTrackingUrl(parseGitHubSkillUrl('https://github.com/owner/repo')))
      .toBe('https://github.com/owner/repo')
    expect(githubSkillTrackingUrl(parseGitHubSkillUrl('https://github.com/owner/repo/tree/main/path/to/skill')))
      .toBe('https://github.com/owner/repo/tree/main/path/to/skill')
  })

  it('treats GitHub commit 422 responses as missing candidate refs and resolves the remaining path', async () => {
    const commitSha = 'c'.repeat(40)
    const skillBlobSha = 'd'.repeat(40)
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ message: 'No commit found for SHA: main/skills/pptx-generator' }, 422))
      .mockResolvedValueOnce(response({ message: 'No commit found for SHA: main/skills' }, 422))
      .mockResolvedValueOnce(response({ sha: commitSha }))
      .mockResolvedValueOnce(response({
        truncated: false,
        tree: [
          { path: 'skills/pptx-generator/SKILL.md', type: 'blob', mode: '100644', sha: skillBlobSha, size: 25 },
        ],
      }))
      .mockResolvedValueOnce(response({
        encoding: 'base64',
        content: Buffer.from('# PPTX Generator\nCreate slides.').toString('base64'),
      }))

    try {
      const preview = await previewGitHubSkill('https://github.com/MiniMax-AI/skills/tree/main/skills/pptx-generator')

      expect(preview.sourceCommitSha).toBe(commitSha)
      expect(preview.sourcePath).toBe('skills/pptx-generator')
      expect(preview.name).toBe('PPTX Generator')
      expect(fetchMock).toHaveBeenCalledTimes(5)
      expect(fetchMock.mock.calls[2][0]).toContain('/commits/main')
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('does not shorten the ref for unrelated GitHub 422 validation errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      message: 'Validation Failed',
    }), { status: 422, headers: { 'Content-Type': 'application/json' } }))
    try {
      await expect(previewGitHubSkill('https://github.com/owner/repo/tree/feature/x/path'))
        .rejects.toThrow('GitHub request failed (422)')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('does not treat a GitHub rate-limit response as an ambiguous ref/path split', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 403 } as Response)
    try {
      await expect(previewGitHubSkill('https://github.com/owner/repo/tree/feature/x/path'))
        .rejects.toThrow('GitHub rate limit reached')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      fetchMock.mockRestore()
    }
  })

  it.each([
    'http://github.com/owner/repo',
    'https://gitlab.com/owner/repo',
    'https://github.com/owner',
    'https://github.com/owner/repo/blob/main/SKILL.md',
    'https://github.com/owner!/repo',
  ])('rejects unsupported URL %s', (url) => {
    expect(() => parseGitHubSkillUrl(url)).toThrow()
  })

  it('rejects non-string and excessively long URL input at the runtime boundary', () => {
    expect(() => parseGitHubSkillUrl(null as unknown as string)).toThrow('valid GitHub URL')
    expect(() => parseGitHubSkillUrl(`https://github.com/owner/repo/${'x'.repeat(2_100)}`)).toThrow('valid GitHub URL')
  })
})

describe('persisted skill validation', () => {
  it('keeps the newest duplicate skill and filters malformed records and tools independently', () => {
    const validTool = installedSkill().tools[0]
    const newest = installedSkill({
      name: 'Newest',
      tools: [
        validTool,
        { ...validTool, entry: 'scripts/duplicate.mjs' },
        { ...validTool, id: 'duplicate-entry', name: 'Duplicate entry' },
        { ...validTool, id: 'nested', entry: 'scripts/nested/run.mjs' },
        { ...validTool, id: 'escape', entry: '../run.mjs' },
        { ...validTool, id: 'runtime', entry: 'scripts/run.py' },
        { ...validTool, id: 'timeout', timeoutMs: Number.POSITIVE_INFINITY },
      ],
    })
    const other = installedSkill({
      id: 'github:owner/repo:other',
      name: 'Other',
      sourcePath: 'other',
      tools: [],
    })

    const result = normalizeInstalledSkills([
      installedSkill({ name: 'Old' }),
      { ...installedSkill(), id: 'wrong-id' },
      { ...installedSkill(), sourceCommitSha: 'not-a-sha' },
      newest,
      other,
    ])

    expect(result.map((skill) => skill.name)).toEqual(['Newest', 'Other'])
    expect(result[0].tools).toEqual([validTool])
  })

  it('rejects non-array registries and invalid package metadata', () => {
    expect(normalizeInstalledSkills(null)).toEqual([])
    expect(normalizeInstalledSkills({ skills: [] })).toEqual([])
    expect(normalizeInstalledSkills([
      installedSkill({ packageSha256: 'bad' }),
      installedSkill({ instructions: '   ' }),
    ])).toEqual([])
  })
})

describe('skill identity and selection', () => {
  it('creates a stable case-insensitive id from repository and path', () => {
    expect(stableSkillId('Owner', 'Repo', 'Path/Skill')).toBe('github:owner/repo:path/skill')
    expect(() => stableSkillId('owner', 'repo', '../escape')).toThrow('escapes')
  })

  it('trims, de-duplicates, filters blanks, and lets enabled win within one layer', () => {
    expect(sanitizeResourceSelection({
      enabledIds: [' a ', 'a', '', ' b '],
      disabledIds: ['b', ' c ', 'c', '  '],
    })).toEqual({
      enabledIds: ['a', 'b'],
      disabledIds: ['c'],
    })
  })

  it('tolerates malformed persisted selection fields but rejects malformed IPC selections', () => {
    expect(sanitizeResourceSelection({ enabledIds: 'not-an-array', disabledIds: null })).toEqual({
      enabledIds: [],
      disabledIds: [],
    })
    expect(() => validateResourceSelection({ enabledIds: ['a'], disabledIds: 'bad' })).toThrow('invalid')
    expect(() => validateResourceSelection({ enabledIds: [''], disabledIds: [] })).toThrow('invalid')
    expect(validateResourceSelection({ enabledIds: [' a ', 'a'], disabledIds: ['b'] })).toEqual({
      enabledIds: ['a'],
      disabledIds: ['b'],
    })
  })

  it('applies explicit conversation choices after project choices', () => {
    expect(resolveSkillSelection(
      ['a', 'b'],
      { enabledIds: ['c'], disabledIds: ['b'] },
      { enabledIds: ['b'], disabledIds: ['a', 'c'] },
    )).toEqual(['b'])
  })
})

describe('enabled skill prompt and tools', () => {
  it('returns no prompt when no skill is enabled', () => {
    expect(skillInstructions([])).toBe('')
  })

  it('includes only supplied skills and forbids model-driven skill discovery or activation', () => {
    const prompt = skillInstructions([installedSkill()])

    expect(prompt).toContain('<skill id="github:owner/repo:" name="Demo">')
    expect(prompt).toContain('# Demo\nDo the thing.')
    expect(prompt).toContain('Do not search for, install, activate, deactivate')
    expect(prompt).not.toContain('Other skill instructions')
  })

  it('creates stable namespaced tools only for supplied skills', () => {
    const skill = installedSkill()
    const first = createSkillTools([skill], project) as Array<{
      function: {
        name: string
        parameters: { properties: { folder_id: { enum: string[] } } }
      }
    }>
    const second = createSkillTools([skill], project) as typeof first

    expect(first).toHaveLength(1)
    expect(first[0].function.name).toMatch(/^skill_[a-f0-9]{10}_run_demo_[a-f0-9]{8}$/)
    expect(second[0].function.name).toBe(first[0].function.name)
    expect(first[0].function.parameters.properties.folder_id.enum).toEqual(['folder-a', 'folder-b'])
    expect(createSkillTools([], project)).toEqual([])
  })

  it('keeps tool names unique when display names sanitize to the same value', () => {
    const skill = installedSkill({
      tools: [
        {
          id: 'a-b',
          name: 'a-b',
          description: 'First tool.',
          runtime: 'node',
          entry: 'scripts/a-b.js',
          timeoutMs: 30_000,
        },
        {
          id: 'a_b',
          name: 'a_b',
          description: 'Second tool.',
          runtime: 'node',
          entry: 'scripts/a_b.js',
          timeoutMs: 30_000,
        },
      ],
    })
    const tools = createSkillTools([skill], project) as Array<{ function: { name: string } }>

    expect(tools).toHaveLength(2)
    expect(new Set(tools.map((tool) => tool.function.name)).size).toBe(2)
  })

  it('does not execute a tool that is not exposed by the enabled skills', async () => {
    await expect(runSkillTool(
      [installedSkill()],
      project,
      { function: { name: 'skill_forged_tool', arguments: '{}' } },
    )).resolves.toBeUndefined()
  })
})
