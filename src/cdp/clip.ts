import type { Box } from './types.js'

export type Viewport = { width: number; height: number }

/**
 * Validate and clamp a screenshot clip rectangle to the visible viewport.
 *
 * Rejects non-finite coordinates/dimensions, non-positive width/height,
 * invalid viewport sizes, and clips that fall completely outside the
 * viewport. Partially overlapping clips are intersected with
 * `[0, viewport.width] x [0, viewport.height]`.
 */
export function clampClip(clip: Box, viewport: Viewport): Box {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    throw new Error(`Invalid viewport dimensions: ${viewport.width}x${viewport.height}`)
  }

  const { x, y, w, h } = clip
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    throw new Error(
      `Screenshot clip must have finite coordinates and dimensions (got x=${x}, y=${y}, w=${w}, h=${h})`,
    )
  }
  if (w <= 0 || h <= 0) {
    throw new Error(`Screenshot clip width and height must be positive (got w=${w}, h=${h})`)
  }

  const left = Math.max(0, x)
  const top = Math.max(0, y)
  const right = Math.min(viewport.width, x + w)
  const bottom = Math.min(viewport.height, y + h)

  const clampedW = right - left
  const clampedH = bottom - top

  if (clampedW <= 0 || clampedH <= 0) {
    throw new Error(
      `Screenshot clip (${x}, ${y}, ${w}x${h}) falls completely outside the viewport (${viewport.width}x${viewport.height})`,
    )
  }

  return { x: left, y: top, w: clampedW, h: clampedH }
}
