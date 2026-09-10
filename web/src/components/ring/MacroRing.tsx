import { useColorScheme } from '@/lib/useColorScheme'
import { overage, resolveColor, surface } from '@/theme/tokens'
import { useEffect, useRef } from 'react'
import {
  OVERAGE_END_T,
  type Rgb,
  animationDurationMs,
  easeOut,
  gradientStops,
  hexToRgb,
  rgbToCss,
  ringColor,
} from './ringColor'

// Port of CalTracker/MacroRing.swift. Canvas rather than SVG because SVG has
// no angular gradient: approximating one with many solid sub-arcs bands
// visibly, and a CSS conic-gradient cannot follow a stroked arc with round
// caps. createConicGradient maps onto SwiftUI's AngularGradient almost
// one-to-one.
//
// The arc is split into ≤90° segments, each with its own gradient, so a ring
// can run past 100% without the gradient smearing across multiple laps.

const SEGMENT_MAX_DEGREES = 90

/**
 * The head's shadow, ported from the two stacked
 * `.shadow(color: .black.opacity(1), radius: strokeWidth * 0.18)` modifiers in
 * MacroRing.swift.
 *
 * Two conversions are needed, and missing either makes the shadow too tight:
 *   * SwiftUI's `radius` is the Gaussian sigma; canvas `shadowBlur` is 2 * sigma.
 *   * Stacking two shadows of sigma s convolves them into sigma s * sqrt(2).
 *
 * So blur = strokeWidth * 0.18 * sqrt(2) * 2, about 0.51 * strokeWidth.
 */
const HEAD_SHADOW_SIGMA_RATIO = 0.18
/** Swift stacks two identical shadows; two fills reproduce the added density. */
const HEAD_SHADOW_PASSES = 2

const headShadowBlur = (strokeWidth: number) =>
  strokeWidth * HEAD_SHADOW_SIGMA_RATIO * Math.SQRT2 * HEAD_SHADOW_PASSES

/**
 * Room reserved around the ring so the canvas boundary is never what bounds the
 * head's shadow — the head's outer edge lands exactly on size / 2.
 *
 * The annulus clip is what actually confines the shadow now, and it stops at the
 * same radius, so this padding no longer changes a pixel. It stays because the
 * clip and the canvas edge should not be the same line: whichever one is
 * responsible ought to be the one chosen on purpose.
 */
const shadowPad = (strokeWidth: number) => Math.max(8, Math.ceil(headShadowBlur(strokeWidth) * 2))

/** Conic-gradient offsets must stay inside [0, 1] and ascend. */
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

type Props = {
  /** 0..∞, where 1 means "at goal". */
  value: number
  /** Two-stop palette gradient, e.g. palette.protein. */
  stops: readonly string[]
  size?: number
  strokeWidth?: number
  /** Skips the fill entirely — used for the dimmed rings on History rows. */
  dimmed?: boolean
}

export function MacroRing({ value, stops, size = 240, strokeWidth = 18, dimmed }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pad = shadowPad(strokeWidth)
  // Not to branch on: canvas keeps its pixels until something redraws them, and
  // the palette is a custom property that changes underneath it.
  const scheme = useColorScheme()
  // Joined so the effect re-runs when the palette changes, without making the
  // dependency array depend on array identity.
  const stopKey = stops.join(',')

  // biome-ignore lint/correctness/useExhaustiveDependencies: scheme is an invalidation key, not a value the body reads — canvas keeps its pixels, and the colours it drew with are custom properties that the OS theme changes underneath it.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Canvas cannot resolve a custom property, so the literals are read back
    // out here rather than handed straight to the context.
    const rgbStops: Rgb[] = stopKey.split(',').map((c) => hexToRgb(resolveColor(c)))
    const trackColor = resolveColor(surface.track)
    const warning = hexToRgb(resolveColor(overage))
    const dpr = window.devicePixelRatio || 1
    // The head circle's outer edge lands exactly on size/2 — the box edge — so
    // its drop shadow would be clipped by the canvas bounds. SwiftUI's .frame()
    // does not clip, and that escaping shadow is the whole spiral-depth effect
    // (it falls on the ring below). Grow the backing store by `pad` on every
    // side and shift the origin; the CSS box stays `size` via a negative offset
    // applied by the caller-visible wrapper below.
    const outer = size + pad * 2
    canvas.width = Math.round(outer * dpr)
    canvas.height = Math.round(outer * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, pad * dpr, pad * dpr)

    const cx = size / 2
    const cy = size / 2
    const radius = (size - strokeWidth) / 2

    const draw = (progress: number) => {
      // Clear in the padded space, not just the box.
      ctx.clearRect(-pad, -pad, outer, outer)

      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.lineWidth = strokeWidth
      ctx.strokeStyle = trackColor
      ctx.stroke()

      if (dimmed) return

      const totalDegrees = Math.max(0, progress * 360)
      const segmentCount = Math.ceil(totalDegrees / SEGMENT_MAX_DEGREES)

      for (let i = 0; i < segmentCount; i++) {
        const startDeg = i * SEGMENT_MAX_DEGREES
        const endDeg = Math.min(startDeg + SEGMENT_MAX_DEGREES, totalDegrees)
        if (endDeg <= startDeg + 0.001) continue

        const startT = startDeg / 360
        const endT = endDeg / 360
        // −90° puts 0% at twelve o'clock; canvas angles run clockwise, which
        // matches SwiftUI's sweep direction.
        const a0 = ((startDeg - 90) * Math.PI) / 180
        const a1 = ((endDeg - 90) * Math.PI) / 180

        // The head exists only to cast a shadow. Its fill is invisible — the
        // arc's round cap at the same point covers it exactly — and the shadow
        // is what lifts the head off the lap running beneath it. That is the
        // whole spiral-depth effect (MacroRing.swift:91-95).
        //
        // So it is drawn only once there IS a lap beneath, and fades in over the
        // same 25° window the colour ramp uses: at 100% the head sits on the lap
        // boundary with nothing under it but the track, and a shadow there is a
        // dark disc over the track rather than depth. Invisible against black,
        // which is why it went unnoticed until the light theme.
        const lapDepth = clamp01((endT - 1) / (OVERAGE_END_T - 1))
        if (i === segmentCount - 1 && lapDepth > 0) {
          ctx.save()

          // Clipped to the ring's own band. Unclipped, the shadow spreads in
          // every direction — outward onto the card and inward across the gap to
          // the next ring — which was invisible against black and an obvious
          // grey smudge once the light theme put a white card behind it. The lap
          // below sits in this band, so confining the shadow to it keeps the
          // depth cue and drops the halo.
          const outerR = radius + strokeWidth / 2
          const innerR = radius - strokeWidth / 2
          ctx.beginPath()
          ctx.arc(cx, cy, outerR, 0, Math.PI * 2)
          // Reversed, so the non-zero winding rule punches the middle out. A
          // degenerate ring (stroke wider than its own radius) has no hole.
          if (innerR > 0) ctx.arc(cx, cy, innerR, 0, Math.PI * 2, true)
          ctx.clip()

          ctx.fillStyle = rgbToCss(ringColor(rgbStops, endT, warning))
          // Black in both themes: within the band it falls on the track and on
          // the arc below, never on the card.
          ctx.shadowColor = `rgba(0,0,0,${lapDepth})`
          ctx.shadowBlur = headShadowBlur(strokeWidth)
          ctx.beginPath()
          ctx.arc(
            cx + Math.cos(a1) * radius,
            cy + Math.sin(a1) * radius,
            strokeWidth / 2,
            0,
            Math.PI * 2,
          )
          for (let pass = 0; pass < HEAD_SHADOW_PASSES; pass++) ctx.fill()
          ctx.restore()
        }

        // SwiftUI's AngularGradient stretches stop locations 0..1 across
        // startAngle→endAngle. createConicGradient stretches them across the
        // full turn, so every location is scaled by this segment's share of
        // it — without that the gradient completes in the first few degrees.
        const share = (a1 - a0) / (Math.PI * 2)
        const grad = ctx.createConicGradient(a0, cx, cy)
        for (const stop of gradientStops(rgbStops, startT, endT, warning)) {
          grad.addColorStop(clamp01(stop.location * share), rgbToCss(stop.color))
        }

        // Round caps overhang the arc by strokeWidth / 2 at BOTH ends, and the
        // leading one reaches backwards past 0° — which in a conic gradient
        // wraps around to just below 1.0. Leaving the end colour there made
        // every segment stamp its darkest shade over the previous segment,
        // showing up as notches at 90°, 180° and 270°. So: hold the end colour
        // just far enough past the arc to cover the trailing cap, then hand the
        // wrap-around region back to the start colour.
        const capFrac = radius > 0 ? strokeWidth / 2 / radius / (Math.PI * 2) : 0
        const endHold = clamp01(share + capFrac * 1.5)
        grad.addColorStop(endHold, rgbToCss(ringColor(rgbStops, endT, warning)))
        if (endHold < 1) {
          grad.addColorStop(
            Math.min(1, endHold + 1e-4),
            rgbToCss(ringColor(rgbStops, startT, warning)),
          )
          grad.addColorStop(1, rgbToCss(ringColor(rgbStops, startT, warning)))
        }

        ctx.beginPath()
        ctx.arc(cx, cy, radius, a0, a1)
        ctx.lineWidth = strokeWidth
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.strokeStyle = grad
        ctx.stroke()
      }
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      draw(value)
      return
    }

    // Like the Swift original, every change animates from zero rather than
    // from the previous value.
    const duration = animationDurationMs(value)
    const startedAt = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const elapsed = now - startedAt
      if (elapsed >= duration) {
        draw(value)
        return
      }
      draw(value * easeOut(elapsed / duration))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, size, strokeWidth, stopKey, dimmed, pad, scheme])

  return (
    // Decorative: every ring is accompanied by the same figures as text (the
    // macro rows on Today, the percentages on History), so there is nothing
    // here a screen reader is not already told. The wrapper carries
    // aria-hidden because biome classifies <canvas> itself as interactive and
    // rejects both aria-hidden and role="presentation" on it directly.
    //
    // The layout box is exactly `size`; the canvas is `pad` larger on each side
    // and pulled back into place, so the head's shadow has somewhere to go
    // without changing how the ring measures or where a RingStack centres it.
    <span
      aria-hidden="true"
      style={{ display: 'block', width: size, height: size, position: 'relative' }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          top: -pad,
          left: -pad,
          width: size + pad * 2,
          height: size + pad * 2,
          display: 'block',
          // Shadows must reach the neighbouring ring, so nothing may capture
          // pointer events on the padded overhang.
          pointerEvents: 'none',
        }}
      />
    </span>
  )
}
