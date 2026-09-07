/**
 * Produce the expression passed to a math renderer without changing the Markdown
 * source retained by Lute. GitHub inline math stores its authoring backticks in
 * the inline math node, while KaTeX expects only the expression between them.
 */
export function normalizeGithubInlineMathSource(
  source: string,
  isInlineMath: boolean,
): string {
  if (
    !isInlineMath ||
    source.length < 2 ||
    source[0] !== '`' ||
    source[source.length - 1] !== '`'
  )
    return source
  return source.slice(1, -1)
}
