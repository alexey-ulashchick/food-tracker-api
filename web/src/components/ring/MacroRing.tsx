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
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const cx = size / 2
    const cy = size / 2
    const radius = (size - strokeWidth) / 2

    const draw = (progress: number) => {
      ctx.clearRect(0, 0, size, size)

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
          grad.addColorStop(Math.min(1, stop.location * share), rgbToCss(stop.color))
        }
        // Pin the remainder so the unused sweep cannot bleed back round.
        grad.addColorStop(1, rgbToCss(ringColor(rgbStops, endT)))

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
    <span aria-hidden="true" style={{ display: 'block', width: size, height: size }}>
      <canvas ref={canvasRef} style={{ width: size, height: size, display: 'block' }} />
    </span>
  )
}
