import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  extractLocalImagePaths,
  ImageAssetWatcher,
  resolveImagePaths,
} from '../../src/session/image-asset-watcher'
import { mock } from './vscode-mock'

// Task 513 — the host half of "an image replaced on disk keeps showing the old bytes": which files
// does an open document actually reference, so that exactly those get watched?
describe('extractLocalImagePaths', () => {
  it('picks up markdown images, with and without a title or angle brackets', () => {
    const md = [
      '![shot](shot.png)',
      '![with title](docs/a.png "A title")',
      '![angled](<my image.png>)',
      '![empty alt]( ./b.jpg )',
    ].join('\n\n')
    expect(extractLocalImagePaths(md).sort()).toEqual([
      './b.jpg',
      'docs/a.png',
      'my image.png',
      'shot.png',
    ])
  })

  it('picks up raw HTML images', () => {
    const md = '<img alt="x" src="assets/pic.png" width="20">'
    expect(extractLocalImagePaths(md)).toEqual(['assets/pic.png'])
  })

  it('ignores everything that is not a file on disk', () => {
    const md = [
      '![remote](https://example.com/a.png)',
      '![proto-relative](//example.com/b.png)',
      '![inline](data:image/png;base64,AAAA)',
      '![blob](blob:vscode-webview://x/y)',
      '[a link](not-an-image.png)',
    ].join('\n\n')
    expect(extractLocalImagePaths(md)).toEqual([])
  })

  it('drops a query or fragment — the file on disk carries neither', () => {
    expect(extractLocalImagePaths('![q](shot.png?v=2#frag)')).toEqual([
      'shot.png',
    ])
  })

  it('deduplicates repeats of the same path', () => {
    expect(
      extractLocalImagePaths('![a](x.png)\n\n![b](x.png)\n\n<img src="x.png">'),
    ).toEqual(['x.png'])
  })

  it('resolves full, collapsed, and shortcut reference images using their first normalized definition', () => {
    const md = [
      '![Full][  DIAGRAM\tONE ]',
      '![Collapsed][]',
      '![Shortcut]',
      '![Encoded][encoded]',
      '',
      '[diagram one]: diagrams/full.png "First definition wins"',
      '[DIAGRAM ONE]: diagrams/duplicate.png',
      "[collapsed]: <images/collapsed image.png> 'A title'",
      '[shortcut]: images/shortcut.png',
      '[encoded]: images/encoded%20name.png?v=2#frag',
    ].join('\n')

    expect(extractLocalImagePaths(md).sort()).toEqual([
      'diagrams/full.png',
      'images/collapsed image.png',
      'images/encoded%20name.png',
      'images/shortcut.png',
    ])
  })

  it('does not treat malformed, escaped, code, or image destinations as reference images', () => {
    const md = [
      '\\![escaped][asset]',
      '`![inline code][asset]`',
      '```markdown',
      '![fenced][asset]',
      '[asset]: fenced.png',
      '```',
      '````markdown',
      '![long-fenced][asset]',
      '[asset]: incorrectly-open.png',
      '```',
      'still fenced',
      '````',
      '    ![indented][asset]',
      '![missing][missing]',
      '![unfinished][asset',
      '![inline](destination.png)',
      '![remote][remote]',
      '![anchor][anchor]',
      '',
      '[asset]: watched.png',
      '![watched][asset]',
      '[remote]: https://example.com/remote.png',
      '[anchor]: #section',
    ].join('\n')

    expect(extractLocalImagePaths(md).sort()).toEqual([
      'destination.png',
      'watched.png',
    ])
  })
})

describe('resolveImagePaths', () => {
  const doc = path.join(path.sep, 'repo', 'docs', 'README.md')

  it('resolves relative to the document folder', () => {
    expect(resolveImagePaths(doc, ['shot.png', '../media/logo.png'])).toEqual([
      path.join(path.sep, 'repo', 'docs', 'shot.png'),
      path.join(path.sep, 'repo', 'media', 'logo.png'),
    ])
  })

  it('percent-decodes a URL-encoded name', () => {
    expect(resolveImagePaths(doc, ['my%20image.png'])).toEqual([
      path.join(path.sep, 'repo', 'docs', 'my image.png'),
    ])
  })

  it('keeps a malformed escape as written instead of throwing', () => {
    expect(resolveImagePaths(doc, ['100%.png'])).toEqual([
      path.join(path.sep, 'repo', 'docs', '100%.png'),
    ])
  })
})

describe('ImageAssetWatcher', () => {
  const doc = path.join(path.sep, 'repo', 'docs', 'README.md')
  beforeEach(() => mock.reset())

  it('watches one file per referenced image and reports a change', () => {
    const notify = vi.fn()
    const watcher = new ImageAssetWatcher(notify)

    watcher.refresh(doc, '![a](a.png)\n\n![b](sub/b.png)')

    expect(mock.state.watchers.length).toBe(2)
    mock.state.watchers[0]!.fireChange()
    expect(notify).toHaveBeenCalledWith([
      path.join(path.sep, 'repo', 'docs', 'a.png'),
    ])
  })

  it('reports a file that appears later (create, not just change)', () => {
    const notify = vi.fn()
    new ImageAssetWatcher(notify).refresh(doc, '![a](a.png)')

    mock.state.watchers.at(-1)!.fireCreate()

    expect(notify).toHaveBeenCalledWith([
      path.join(path.sep, 'repo', 'docs', 'a.png'),
    ])
  })

  it('is a no-op while the referenced set is unchanged (typing must not churn watchers)', () => {
    const watcher = new ImageAssetWatcher(vi.fn())
    watcher.refresh(doc, '![a](a.png)\n\ntext')
    const created = mock.state.watchers.length

    watcher.refresh(doc, '![a](a.png)\n\ntext typed on')

    expect(mock.state.watchers.length).toBe(created)
    expect(mock.state.watchers.every((w) => !w.disposed)).toBe(true)
  })

  it('replaces the watchers when the referenced set changes', () => {
    const watcher = new ImageAssetWatcher(vi.fn())
    watcher.refresh(doc, '![a](a.png)')
    const first = mock.state.watchers.at(-1)!

    watcher.refresh(doc, '![b](b.png)')

    expect(first.disposed).toBe(true)
    expect(mock.state.watchers.at(-1)).not.toBe(first)
  })

  it('updates the watched reference destination when its definition is retargeted', () => {
    const notify = vi.fn()
    const watcher = new ImageAssetWatcher(notify)
    watcher.refresh(doc, '![Diagram][asset]\n\n[asset]: first.png')
    const first = mock.state.watchers.at(-1)!

    watcher.refresh(doc, '![Diagram][asset]\n\n[asset]: second.png')

    expect(first.disposed).toBe(true)
    mock.state.watchers.at(-1)!.fireChange()
    expect(notify).toHaveBeenCalledWith([
      path.join(path.sep, 'repo', 'docs', 'second.png'),
    ])
  })

  it('watches nothing for a document with no local images', () => {
    new ImageAssetWatcher(vi.fn()).refresh(
      doc,
      '![remote](https://example.com/x.png)',
    )
    expect(mock.state.watchers.length).toBe(0)
  })

  it('disposes every watcher it created', () => {
    const watcher = new ImageAssetWatcher(vi.fn())
    watcher.refresh(doc, '![a](a.png)\n\n![b](b.png)')

    watcher.dispose()

    expect(mock.state.watchers.every((w) => w.disposed)).toBe(true)
  })
})
