/**
 * Task 639 — pure content-aware table column width allocation.
 *
 * Given per-column min-content and max-content widths and the width the table must fill, returns
 * integer pixel widths that sum to `floor(available)`. No DOM access.
 */

export interface ColumnWidthInput {
  /** Per-column min-content width (wrap and break normal), border-box px. */
  min: readonly number[]
  /** Per-column max-content width (nowrap), border-box px. */
  max: readonly number[]
  /** Width the table must fill, px. */
  available: number
  /** Per-column floor, px. */
  minimum: number
}

const sumOf = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0)

/** Integer widths by largest remainder; ties go to the lower column index. */
function roundToTotal(widths: readonly number[], total: number): number[] {
  const floors = widths.map((width) => Math.floor(width))
  let extra = total - sumOf(floors)
  const order = widths
    .map((width, index) => ({ index, fraction: width - Math.floor(width) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (const { index } of order) {
    if (extra <= 0) break
    floors[index] += 1
    extra -= 1
  }
  return floors
}

/** Split `remaining` over `indexes` in proportion to max, pinning columns that fall below min. */
function splitLongColumns(
  widths: number[],
  indexes: number[],
  remaining: number,
  min: readonly number[],
  max: readonly number[],
): void {
  let open = indexes
  let room = remaining
  for (;;) {
    const maxTotal = sumOf(open.map((index) => max[index]))
    const pinned = open.filter(
      (index) => (room * max[index]) / maxTotal < min[index],
    )
    if (pinned.length === 0) {
      for (const index of open) widths[index] = (room * max[index]) / maxTotal
      return
    }
    for (const index of pinned) {
      widths[index] = min[index]
      room -= min[index]
    }
    open = open.filter((index) => !pinned.includes(index))
    if (open.length === 0) return
  }
}

export function allocateColumnWidths({
  min,
  max,
  available,
  minimum,
}: ColumnWidthInput): number[] {
  const count = min.length
  if (count === 0) return []
  const total = Math.floor(available)
  const lows = min.map((value) => Math.max(minimum, value))
  const highs = max.map((value, index) => Math.max(lows[index], value))

  const minTotal = sumOf(lows)
  if (minTotal > total) {
    // Over-wide table: content cannot be honoured without breaking more words than equal widths
    // do, so keep today's equal layout instead of redistributing.
    return roundToTotal(
      lows.map(() => total / count),
      total,
    )
  }

  const maxTotal = sumOf(highs)
  if (maxTotal <= total) {
    return roundToTotal(
      highs.map((value) => (value * total) / maxTotal),
      total,
    )
  }

  const widths = new Array<number>(count).fill(0)
  let open = highs.map((_, index) => index)
  let room = total
  for (;;) {
    const share = room / open.length
    const fits = open.filter((index) => highs[index] <= share)
    if (fits.length === 0) break
    // A column that takes its max-content is rounded up to a whole pixel while the room allows:
    // the largest-remainder rounding would otherwise floor it and wrap its last word by a
    // fraction of a pixel. The room must still cover the columns that are not placed yet at their
    // min-content; when it does not, the fractional value stays. Integer inputs are unchanged.
    const reserve = sumOf(
      open.filter((index) => !fits.includes(index)).map((index) => lows[index]),
    )
    let pending = sumOf(fits.map((index) => highs[index]))
    for (const index of fits) {
      pending -= highs[index]
      const rounded = Math.ceil(highs[index])
      widths[index] =
        room - rounded - pending >= reserve ? rounded : highs[index]
      room -= widths[index]
    }
    open = open.filter((index) => !fits.includes(index))
    if (open.length === 0) break
  }
  if (open.length > 0) splitLongColumns(widths, open, room, lows, highs)
  return roundToTotal(widths, total)
}
