import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectProjectFolder, formatProjectDetections } from '../src/main/project-detection'
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await createTemporaryDirectory('codey-project-detection-')
  temporaryDirectories.push(directory)
  return directory
}

describe('project detection', () => {
  it('detects a Node frontend and its package manager', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'demo-ui',
      scripts: { dev: 'vite', build: 'vite build' },
      devDependencies: { vite: '^7.0.0', react: '^19.0.0' },
    }), 'utf8')
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')

    const detection = await detectProjectFolder({ id: 'frontend', path: root })

    expect(detection).toMatchObject({
      runtimes: ['node'],
      kinds: ['frontend'],
      frameworks: ['React', 'Vite'],
      packageManager: 'pnpm',
      packageName: 'demo-ui',
      scripts: ['dev', 'build'],
    })
  })

  it('keeps mixed Python and Tauri runtimes visible', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'src-tauri'))
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: { '@tauri-apps/api': '^2.0.0', vue: '^3.0.0' },
      scripts: { tauri: 'tauri', dev: 'vite' },
    }), 'utf8')
    await writeFile(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "demo"\n', 'utf8')
    await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "helper"\n', 'utf8')

    const detection = await detectProjectFolder({ id: 'mixed', path: root })

    expect(detection.runtimes).toEqual(['node', 'rust', 'python'])
    expect(detection.kinds).toEqual(['desktop', 'frontend'])
    expect(detection.frameworks).toEqual(['Vue', 'Tauri'])
    expect(detection.evidence).toEqual(expect.arrayContaining([
      'src-tauri/Cargo.toml found',
      'Python project files found: pyproject.toml',
    ]))
  })

  it('reports malformed package metadata without failing the request', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'package.json'), '{not-json', 'utf8')
    await writeFile(join(root, 'main.py'), 'print("ok")\n', 'utf8')

    const detection = await detectProjectFolder({ id: 'unknown', path: root })

    expect(detection.runtimes).toEqual(['python', 'node'])
    expect(detection.evidence).toEqual(expect.arrayContaining([
      'package.json found but could not be parsed',
      'root contains Python source files',
    ]))
    expect(formatProjectDetections([{ id: 'unknown', path: root }], [detection])[0]).toContain('runtimes=python,node')
  })
})
