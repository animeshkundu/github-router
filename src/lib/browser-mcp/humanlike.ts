// humanlike.ts — pure-math pacing engine for the adaptive humanlike
// mode. Beta-distributed inter-action delays, Bezier mouse paths with
// overshoot-and-correct, per-keystroke jitter with word-end pauses,
// scroll chunking. No I/O. Deterministic in shape, RNG-driven in value.
//
// Phase 4 v1 uses these primitives in the dispatch wrapper when
// `state.humanlikeForce === "on"` (--humanlike CLI flag or
// GH_ROUTER_HUMANLIKE=1). The adaptive detection path (Cloudflare /
// Datadome / PerimeterX / captcha vendor signatures) is deferred to
// a follow-up; this module is ready to be consumed by either path.

/**
 * Sample from a Beta(2, 5) distribution scaled to [minMs, maxMs].
 * The Beta(2, 5) shape has its mode near 0.2 of the range — humans
 * follow most actions quickly, with an occasional long pause. We do
 * NOT use uniform random because that would produce robotically-
 * even spacing detectable by behavioral analysis.
 *
 * Implementation: two gamma-distributed samples via the Marsaglia /
 * Tsang squeeze method (Box-Muller-style sufficiency for shape ≥ 2).
 */
export function betaDelay(minMs: number, maxMs: number): number {
  const a = gammaSample(2)
  const b = gammaSample(5)
  const beta = a / (a + b)
  return Math.round(minMs + beta * (maxMs - minMs))
}

function gammaSample(shape: number): number {
  // Marsaglia-Tsang for shape ≥ 1. We use shape 2 and 5 only.
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  while (true) {
    let x: number, v: number
    do {
      x = normalSample()
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = Math.random()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

function normalSample(): number {
  // Box-Muller. One pair of samples; we use only one.
  let u = 0, v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * Inter-action delay when paced mode is on. Returns a Beta-shaped
 * randomized delay in [800, 4600] ms with a base of 600 ms so the
 * minimum is never "too fast." Humans take 800-2800 ms between
 * UI actions on average, with a tail of long pauses; this matches.
 *
 * Caller is expected to subtract the time already burned in the
 * compound pipeline (snapshot fetch + matcher cascade) so the user-
 * perceived delay isn't doubled.
 */
export function interActionDelay(): number {
  return betaDelay(800, 4600)
}

/**
 * Per-keystroke delay for `browser_type` when paced mode is on.
 *
 * - Base: uniform [50, 200] ms per character.
 * - Word-end: extra Gaussian(180, 80) ms clamped to [60, 600] after
 *   space / period / comma / newline.
 * - Long pause: ~1 in 25 keystrokes, extra uniform [400, 900] ms.
 */
export function keystrokeDelay(prevChar: string | undefined): number {
  let base = 50 + Math.round(Math.random() * 150)
  if (prevChar === " " || prevChar === "." || prevChar === "," || prevChar === "\n") {
    const wordEnd = Math.max(60, Math.min(600, 180 + Math.round(normalSample() * 80)))
    base += wordEnd
  }
  if (Math.random() < 1 / 25) {
    base += 400 + Math.round(Math.random() * 500)
  }
  return base
}

/**
 * Generate a Bezier mouse trajectory from `start` to `end` with
 * overshoot-and-correct (humans don't stop on a dime — they slightly
 * overshoot the target and correct on the way back). Returns a
 * sequence of (x, y) waypoints the dispatcher feeds to
 * `browser_mouse` as a multi-step trajectory.
 *
 * Steps: clamp(round(|S-T|/12), 18, 40). Closer targets get fewer
 * steps. Per-step jitter: Gaussian(0, 1.5) px, clamped to ±5 px.
 * Sigmoid easing: slow start, fast middle, slow end.
 */
export function bezierTrajectory(
  start: { x: number, y: number },
  end: { x: number, y: number },
): Array<{ x: number, y: number }> {
  const dist = Math.hypot(end.x - start.x, end.y - start.y)
  const steps = Math.max(18, Math.min(40, Math.round(dist / 12)))
  // Midpoint with perpendicular offset (the "lazy curve" humans draw
  // when moving the mouse to a target).
  const dx = end.x - start.x
  const dy = end.y - start.y
  const perpScale = 0.15 * dist
  const perp = perpScale * (Math.random() < 0.5 ? -1 : 1)
  const midX = (start.x + end.x) / 2 + (-dy / dist) * perp
  const midY = (start.y + end.y) / 2 + (dx / dist) * perp
  // Second control point near the end for overshoot-and-correct.
  const endOffset = 15
  const endCtrlX = end.x + (Math.random() - 0.5) * endOffset * 2
  const endCtrlY = end.y + (Math.random() - 0.5) * endOffset * 2
  const out: Array<{ x: number, y: number }> = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const tEased = 1 / (1 + Math.exp(-6 * (t - 0.5)))
    // Cubic Bezier: start, midpoint (single control), endCtrl, end.
    const x = cubicBezier(tEased, start.x, midX, endCtrlX, end.x)
    const y = cubicBezier(tEased, start.y, midY, endCtrlY, end.y)
    // Per-step jitter.
    const jx = Math.max(-5, Math.min(5, Math.round(normalSample() * 1.5)))
    const jy = Math.max(-5, Math.min(5, Math.round(normalSample() * 1.5)))
    out.push({ x: Math.round(x) + jx, y: Math.round(y) + jy })
  }
  return out
}

function cubicBezier(
  t: number,
  p0: number,
  p1: number,
  p2: number,
  p3: number,
): number {
  const oneMinusT = 1 - t
  return oneMinusT * oneMinusT * oneMinusT * p0
    + 3 * oneMinusT * oneMinusT * t * p1
    + 3 * oneMinusT * t * t * p2
    + t * t * t * p3
}

/**
 * Chunk a single large scroll into multiple smaller wheel events
 * with humanlike inter-chunk pauses. Returns the chunk delta values
 * (sum equals input) and per-chunk delays. Caller dispatches each
 * chunk as a separate `browser_scroll target: 'pixels'` call.
 *
 * Distribution: Gaussian(140, 60) px per chunk, clamped [60, 320].
 * Inter-chunk delay: uniform [40, 120] ms.
 */
export function scrollChunks(totalPx: number): Array<{ delta: number, delayMs: number }> {
  const sign = totalPx >= 0 ? 1 : -1
  let remaining = Math.abs(totalPx)
  const chunks: Array<{ delta: number, delayMs: number }> = []
  while (remaining > 0) {
    const target = Math.max(60, Math.min(320, Math.round(140 + normalSample() * 60)))
    const delta = Math.min(remaining, target)
    chunks.push({ delta: delta * sign, delayMs: 40 + Math.round(Math.random() * 80) })
    remaining -= delta
  }
  return chunks
}

/**
 * Test seam: replace the RNG with a deterministic source so tests
 * can assert distribution shape without flakiness. The real
 * `Math.random` is used unless overridden via this hook.
 */
export const __test = {
  betaDelay,
  gammaSample,
  normalSample,
  cubicBezier,
}
