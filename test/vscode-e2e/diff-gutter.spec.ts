import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

// Launch in a temporary real multi-root workspace so adding and removing the disposable Git root
// stays reversible without letting VS Code rewrite a tracked .code-workspace fixture.
const workspaceDir = mkdtempSync(
  path.join(tmpdir(), 'vmde-diff-gutter-workspace-'),
)
const cleanupWorkspace = () =>
  rmSync(workspaceDir, { recursive: true, force: true })
process.once('exit', cleanupWorkspace)
const workspaceFile = path.join(workspaceDir, 'diff-gutter.code-workspace')
const scopedRoots = path.join(__dirname, 'fixtures', 'scoped-roots')
writeFileSync(
  workspaceFile,
  JSON.stringify(
    {
      folders: [
        { path: path.join(scopedRoots, 'docs') },
        { path: path.join(scopedRoots, 'notes') },
      ],
    },
    null,
    2,
  ),
)

test.afterAll(() => {
  process.removeListener('exit', cleanupWorkspace)
  cleanupWorkspace()
})

const WORKSPACE = workspaceFile
test.use({ baseDir: WORKSPACE })

test('a saved git change restores its gutter marker after close and reopen', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(120_000)
  const tempRepo = mkdtempSync(path.join(tmpdir(), 'vmde-diff-gutter-'))
  const note = path.join(tempRepo, 'note.md')

  try {
    writeFileSync(
      note,
      'Before paragraph.\n\n- first item\n- second item\n\nAfter paragraph.\n',
    )
    execFileSync('git', ['init', '--quiet'], { cwd: tempRepo })
    execFileSync('git', ['config', 'user.name', 'Vmde E2E'], {
      cwd: tempRepo,
    })
    execFileSync('git', ['config', 'user.email', 'vmde-e2e@example.invalid'], {
      cwd: tempRepo,
    })
    execFileSync('git', ['add', 'note.md'], { cwd: tempRepo })
    execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'baseline'],
      { cwd: tempRepo },
    )

    await evaluateInVSCode(
      async (vscode, args) => {
        const repoPath = (args as string[])[0]
        const folders = vscode.workspace.workspaceFolders ?? []
        await new Promise<void>((resolve, reject) => {
          const listener = vscode.workspace.onDidChangeWorkspaceFolders(
            (event) => {
              if (
                event.added.some((folder) => folder.uri.fsPath === repoPath)
              ) {
                clearTimeout(timeout)
                listener.dispose()
                resolve()
              }
            },
          )
          const timeout = setTimeout(() => {
            listener.dispose()
            reject(new Error('temporary Git workspace folder was not added'))
          }, 10_000)
          const added = vscode.workspace.updateWorkspaceFolders(
            folders.length,
            0,
            {
              uri: vscode.Uri.file(repoPath),
              name: 'vmde-diff-gutter-e2e',
            },
          )
          if (!added) {
            clearTimeout(timeout)
            listener.dispose()
            reject(new Error('temporary Git workspace folder was rejected'))
          }
        })
      },
      [tempRepo] as [string],
    )
    await evaluateInVSCode(
      async (vscode, args) => {
        const filePath = (args as string[])[0]
        await vscode.extensions.getExtension('vscode.git')?.activate()
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(filePath),
          'vmde.editor',
        )
      },
      [note] as [string],
    )

    let frame = wf(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
    await waitForE2EReadiness(
      frame,
      (snapshot) => snapshot.routerReady && snapshot.editorEpoch > 0,
      { message: 'the diff-gutter editor installed its update router' },
    )
    await expect
      .poll(() =>
        evaluateInVSCode(
          async (vscode: typeof import('vscode'), args: string[]) => {
            const git = vscode.extensions.getExtension('vscode.git')
            const repositories = git?.exports?.getAPI?.(1)?.repositories ?? []
            return repositories.some(
              (repository: { rootUri: { fsPath: string } }) =>
                repository.rootUri.fsPath === args[0],
            )
          },
          [tempRepo] as [string],
        ),
      )
      .toBe(true)

    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        const document = vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.fsPath === args[0],
        )
        if (!document) throw new Error('temporary diff TextDocument not found')
        const line = document.lineAt(3)
        const edit = new vscode.WorkspaceEdit()
        edit.insert(document.uri, line.range.end, ' edited')
        if (!(await vscode.workspace.applyEdit(edit)))
          throw new Error('temporary diff edit was rejected')
        if (!(await document.save()))
          throw new Error('temporary diff document did not save')
      },
      [note] as [string],
    )

    const readResult = () =>
      frame.locator('body').evaluate(() => {
        const editor = document.querySelector('.vditor-ir .vditor-reset')
        const bars = Array.from(
          document.querySelectorAll('.me-diff-marker'),
        ) as HTMLElement[]
        const blocks = Array.from(editor?.children ?? []) as HTMLElement[]
        return {
          bars: bars.map((bar) => ({
            className: bar.className,
            top: bar.offsetTop,
          })),
          blocks: blocks
            .filter((block) => !block.classList.contains('me-diff-marker'))
            .map((block) => ({
              text: block.textContent,
              top: block.offsetTop,
            })),
        }
      })
    const hasAlignedModifiedMarker = async () => {
      const result = await readResult()
      const listBlock = result.blocks.find((block) =>
        block.text?.includes('second item edited'),
      )
      return (
        result.bars.length === 1 &&
        result.bars[0].className.includes('me-diff-marker--modified') &&
        listBlock !== undefined &&
        result.bars[0].top === listBlock.top
      )
    }
    await expect.poll(hasAlignedModifiedMarker).toBe(true)

    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    })
    await expect
      .poll(() => workbox.locator('iframe.webview').count(), {
        timeout: 30_000,
      })
      .toBe(0)

    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(args[0]),
          'vmde.editor',
        )
      },
      [note] as [string],
    )
    frame = wf(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
    await waitForE2EReadiness(
      frame,
      (snapshot) => snapshot.routerReady && snapshot.editorEpoch > 0,
      { message: 'the reopened diff-gutter editor completed initialization' },
    )
    await expect.poll(hasAlignedModifiedMarker).toBe(true)

    const result = await readResult()
    expect(result.bars).toHaveLength(1)
    expect(result.bars[0].className).toContain('me-diff-marker--modified')
    const listBlock = result.blocks.find((block) =>
      block.text?.includes('second item edited'),
    )
    expect(listBlock).toBeDefined()
    expect(result.bars[0].top).toBe(listBlock?.top)
  } finally {
    try {
      await evaluateInVSCode(
        async (vscode: typeof import('vscode'), args: string[]) => {
          await vscode.commands.executeCommand(
            'workbench.action.closeAllEditors',
          )
          const repoPath = args[0]
          const index = (vscode.workspace.workspaceFolders ?? []).findIndex(
            (folder) => folder.uri.fsPath === repoPath,
          )
          if (index < 0) return
          await new Promise<void>((resolve, reject) => {
            const listener = vscode.workspace.onDidChangeWorkspaceFolders(
              (event) => {
                if (
                  event.removed.some((folder) => folder.uri.fsPath === repoPath)
                ) {
                  clearTimeout(timeout)
                  listener.dispose()
                  resolve()
                }
              },
            )
            const timeout = setTimeout(() => {
              listener.dispose()
              reject(
                new Error('temporary Git workspace folder was not removed'),
              )
            }, 10_000)
            if (!vscode.workspace.updateWorkspaceFolders(index, 1)) {
              clearTimeout(timeout)
              listener.dispose()
              const folders = (vscode.workspace.workspaceFolders ?? []).map(
                (folder) => folder.uri.fsPath,
              )
              reject(
                new Error(
                  `temporary Git workspace folder removal was rejected; workspaceFile=${vscode.workspace.workspaceFile?.fsPath ?? 'none'} folders=${JSON.stringify(folders)}`,
                ),
              )
            }
          })
        },
        [tempRepo] as [string],
      )
    } finally {
      rmSync(tempRepo, { recursive: true, force: true })
    }
  }
})
