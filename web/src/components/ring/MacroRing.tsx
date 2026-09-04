import { surface } from '@/theme/tokens'
import { useEffect, useRef } from 'react'
import {
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
 * Room reserved around the ring for the head's drop shadow. The blur is
 * strokeWidth * 0.18 * 2 and the widest stroke in the app is 18, so 8px covers
 * every call site with margin. Padding costs a few pixels of backing store and
 * buys a shadow that behaves like SwiftUI's — spilling past the frame instead
 * of being sliced off at it.
 */
const SHADOW_PAD = 8

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
  // Joined so the effect re-runs when the palette changes, without making the
  // dependency array depend on array identity.
  const stopKey = stops.join(',')

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const rgbStops: Rgb[] = stopKey.split(',').map(hexToRgb)
    const dpr = window.devicePixelRatio || 1
    // The head circle's outer edge lands exactly on size/2 — the box edge — so
    // its drop shadow would be clipped by the canvas bounds. SwiftUI's .frame()
    // does not clip, and that escaping shadow is the whole spiral-depth effect
    // (it falls on the ring below). Grow the backing store by SHADOW_PAD on
    // every side and shift the origin; the CSS box stays `size` via a negative
    // offset applied by the caller-visible wrapper below.
    const outer = size + SHADOW_PAD * 2
    canvas.width = Math.round(outer * dpr)
    canvas.height = Math.round(outer * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, SHADOW_PAD * dpr, SHADOW_PAD * dpr)

    const cx = size / 2
    const cy = size / 2
    const radius = (size - strokeWidth) / 2

    const draw = (progress: number) => {
      // Clear in the padded space, not just the box.
      ctx.clearRect(-SHADOW_PAD, -SHADOW_PAD, outer, outer)

      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.lineWidth = strokeWidth
      ctx.strokeStyle = surface.track
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

        // The head is drawn BEFORE its own arc so the round cap covers it and
        // only its shadow escapes, falling on the lap below. That single
        // detail is the entire spiral-depth effect (MacroRing.swift:91-95).
        if (i === segmentCount - 1) {
          ctx.save()
          ctx.fillStyle = rgbToCss(ringColor(rgbStops, endT))
          ctx.shadowColor = 'rgba(0,0,0,1)'
          // SwiftUI's shadow radius is the blur sigma; canvas shadowBlur is
          // roughly 2σ. Swift stacks two identical shadows, hence two fills.
          ctx.shadowBlur = strokeWidth * 0.18 * 2
          ctx.beginPath()
          ctx.arc(
            cx + Math.cos(a1) * radius,
            cy + Math.sin(a1) * radius,
            strokeWidth / 2,
            0,
            Math.PI * 2,
          )
          ctx.fill()
          ctx.fill()
          ctx.restore()
        }

        // SwiftUI's AngularGradient stretches stop locations 0..1 across
        // startAngle→endAngle. createConicGradient stretches them across the
        // full turn, so every location is scaled by this segment's share of
        // it — without that the gradient completes in the first few degrees.
        const share = (a1 - a0) / (Math.PI * 2)
        const grad = ctx.createConicGradient(a0, cx, cy)
        for (const stop of gradientStops(rgbStops, startT, endT)) {
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
        grad.addColorStop(endHold, rgbToCss(ringColor(rgbStops, endT)))
        if (endHold < 1) {
          grad.addColorStop(Math.min(1, endHold + 1e-4), rgbToCss(ringColor(rgbStops, startT)))
          grad.addColorStop(1, rgbToCss(ringColor(rgbStops, startT)))
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
  }, [value, size, strokeWidth, stopKey, dimmed])

  return (
    // Decorative: every ring is accompanied by the same figures as text (the
    // macro rows on Today, the percentages on History), so there is nothing
    // here a screen reader is not already told. The wrapper carries
    // aria-hidden because biome classifies <canvas> itself as interactive and
    // rejects both aria-hidden and role="presentation" on it directly.
    //
    // The layout box is exactly `size`; the canvas is SHADOW_PAD larger on each
    // side and pulled back into place, so the head's shadow has somewhere to go
    // without changing how the ring measures or where a RingStack centres it.
    <span
      aria-hidden="true"
      style={{ display: 'block', width: size, height: size, position: 'relative' }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          top: -SHADOW_PAD,
          left: -SHADOW_PAD,
          width: size + SHADOW_PAD * 2,
          height: size + SHADOW_PAD * 2,
          display: 'block',
          // Shadows must reach the neighbouring ring, so nothing may capture
          // pointer events on the padded overhang.
          pointerEvents: 'none',
        }}
      />
    </span>
  )
}
