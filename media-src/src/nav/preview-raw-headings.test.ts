import { describe, expect, it } from 'vitest'
import {
  markRawHeadingsForPreview,
  RAW_HEADING_ATTR,
} from './preview-raw-headings'

// Task 660: the Preview-only source mask marks raw HTML `<hN>` elements so section indentation can
// tell them apart from Markdown headings. Each skip case is a place where the text is not an
// element (code, front matter, math) or cannot be top level.
const MARK = ` ${RAW_HEADING_ATTR}="1"`

describe('markRawHeadingsForPreview (task 660)', () => {
  it('returns the source unchanged when it has no <hN', () => {
    const md = '# Title\n\ntext <div>x</div>\n'
    expect(markRawHeadingsForPreview(md)).toBe(md)
  })

  it('marks a bare block heading', () => {
    expect(markRawHeadingsForPreview('<h2>Bare</h2>')).toBe(
      `<h2${MARK}>Bare</h2>`,
    )
  })

  it('marks an uppercase tag with attributes and keeps the attributes', () => {
    expect(markRawHeadingsForPreview('<H3 class="c" id="x">Up</H3>')).toBe(
      `<H3${MARK} class="c" id="x">Up</H3>`,
    )
  })

  it('marks a heading on an HTML-block continuation line', () => {
    expect(markRawHeadingsForPreview('<div></div>\n<h4>next</h4>')).toBe(
      `<div></div>\n<h4${MARK}>next</h4>`,
    )
  })

  it('marks an inline heading inside a paragraph and a self-closing form', () => {
    expect(markRawHeadingsForPreview('para <h2>inline</h2> tail')).toBe(
      `para <h2${MARK}>inline</h2> tail`,
    )
    expect(markRawHeadingsForPreview('<h5/>')).toBe(`<h5${MARK}/>`)
  })

  it('marks every heading of a line', () => {
    expect(markRawHeadingsForPreview('<h1>a</h1><h2>b</h2>')).toBe(
      `<h1${MARK}>a</h1><h2${MARK}>b</h2>`,
    )
  })

  it('does not match longer tag names such as <h1x> or <hr>', () => {
    const md = '<h1x>a</h1x> <hr> <header>b</header>'
    expect(markRawHeadingsForPreview(md)).toBe(md)
  })

  it('skips a single-line code span but marks the text around it', () => {
    expect(
      markRawHeadingsForPreview('a `<h2>code</h2>` and <h3>real</h3>'),
    ).toBe(`a \`<h2>code</h2>\` and <h3${MARK}>real</h3>`)
    expect(markRawHeadingsForPreview('``<h2>x</h2>`` b')).toBe(
      '``<h2>x</h2>`` b',
    )
  })

  it('skips a tag escaped by a backslash', () => {
    expect(markRawHeadingsForPreview('\\<h2>esc</h2>')).toBe('\\<h2>esc</h2>')
  })

  it('skips indented code (4 spaces or a tab)', () => {
    expect(markRawHeadingsForPreview('    <h2>code</h2>')).toBe(
      '    <h2>code</h2>',
    )
    expect(markRawHeadingsForPreview('\t<h2>code</h2>')).toBe('\t<h2>code</h2>')
  })

  it('skips fenced code, backtick and tilde, and resumes after the closing fence', () => {
    const md =
      '```html\n<h2>a</h2>\n```\n<h3>b</h3>\n~~~~\n<h2>c</h2>\n~~~~\n<h4>d</h4>'
    expect(markRawHeadingsForPreview(md)).toBe(
      `\`\`\`html\n<h2>a</h2>\n\`\`\`\n<h3${MARK}>b</h3>\n~~~~\n<h2>c</h2>\n~~~~\n<h4${MARK}>d</h4>`,
    )
  })

  it('skips a $$ math block and resumes after it', () => {
    const md = '$$\n<h2>m</h2>\n$$\n<h3>r</h3>'
    expect(markRawHeadingsForPreview(md)).toBe(
      `$$\n<h2>m</h2>\n$$\n<h3${MARK}>r</h3>`,
    )
  })

  it('skips leading front matter only', () => {
    const md = '---\ntitle: <h2>fm</h2>\n---\n<h2>body</h2>'
    expect(markRawHeadingsForPreview(md)).toBe(
      `---\ntitle: <h2>fm</h2>\n---\n<h2${MARK}>body</h2>`,
    )
    const later = 'text\n---\n<h2>not front</h2>\n---'
    expect(markRawHeadingsForPreview(later)).toBe(
      `text\n---\n<h2${MARK}>not front</h2>\n---`,
    )
  })

  it('skips pre, script, style and textarea blocks up to the closing tag', () => {
    const md =
      '<textarea>\n<h2>in</h2>\n</textarea>\n<h3>out</h3>\n<pre><h4>x</h4></pre>\n<h5>y</h5>'
    expect(markRawHeadingsForPreview(md)).toBe(
      `<textarea>\n<h2>in</h2>\n</textarea>\n<h3${MARK}>out</h3>\n<pre><h4>x</h4></pre>\n<h5${MARK}>y</h5>`,
    )
  })

  it('is idempotent on its own output only through a single pass (no double mark)', () => {
    const once = markRawHeadingsForPreview('<h2>a</h2>')
    expect(once.split(RAW_HEADING_ATTR).length - 1).toBe(1)
  })
  it('does not mark a heading inside a fence opened in a quote, and keeps scanning after it', () => {
    const md = '> ```html\n> <h2>x</h2>\n> ```\n<h3>real</h3>'
    expect(markRawHeadingsForPreview(md)).toBe(
      `> \`\`\`html\n> <h2>x</h2>\n> \`\`\`\n<h3${MARK}>real</h3>`,
    )
  })

  it('a list-item fence with an unprefixed closing fence does not leave a fence open', () => {
    const md = '- ```\n  <h2>x</h2>\n  ```\n<h3>real</h3>'
    expect(markRawHeadingsForPreview(md)).toBe(
      `- \`\`\`\n  <h2>x</h2>\n  \`\`\`\n<h3${MARK}>real</h3>`,
    )
  })

  it('never marks a heading on a line with a quote or list prefix (it is nested)', () => {
    const md = '> <h2>q</h2>\n- <h3>l</h3>\n1. <h4>n</h4>\n> - <h5>m</h5>'
    expect(markRawHeadingsForPreview(md)).toBe(md)
  })

  it('treats an even run of backslashes before the tag as not an escape', () => {
    expect(markRawHeadingsForPreview('\\\\<h2>x</h2>')).toBe(
      `\\\\<h2${MARK}>x</h2>`,
    )
    expect(markRawHeadingsForPreview('\\<h2>x</h2>')).toBe('\\<h2>x</h2>')
  })

  it('skips inline math and reads CRLF front matter', () => {
    expect(markRawHeadingsForPreview('a $<h2>$ b <h3>c</h3>')).toBe(
      `a $<h2>$ b <h3${MARK}>c</h3>`,
    )
    const md = '---\r\ntitle: <h2>x</h2>\r\n---\r\n<h2>body</h2>'
    expect(markRawHeadingsForPreview(md)).toBe(
      `---\r\ntitle: <h2>x</h2>\r\n---\r\n<h2${MARK}>body</h2>`,
    )
  })
  it('a line starting with emphasis or a digit run is not a container', () => {
    expect(markRawHeadingsForPreview('*em* <h2>x</h2>\n2024 <h3>y</h3>')).toBe(
      `*em* <h2${MARK}>x</h2>\n2024 <h3${MARK}>y</h3>`,
    )
  })
})
