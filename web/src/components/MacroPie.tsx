import { useColorScheme } from '@/lib/useColorScheme'
import { resolveColor } from '@/theme/tokens'
import { useEffect, useRef } from 'react'

// Port of CalTracker/MacroPie.swift: a tiny donut showing the protein/carb/fat
// split by grams — equal grams give equal arcs. Canvas here too, because the
// Swift original is a Canvas and butt-capped abutting arcs are simplest to
// reproduce with the same primitives.

type Props = {
  protein: number
  carbs: number
  fat: number
  proteinColor: string
  carbsColor: string
  fatColor: string
  size?: number
  strokeWidth?: number
}

export function MacroPie({
  protein,
  carbs,
  fat,
  proteinColor,
  carbsColor,
  fatColor,
  size = 24,
  strokeWidth = 5.5,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Redraw when the OS theme flips; the colours arrive as custom properties.
  const scheme = useColorScheme()

  // biome-ignore lint/correctness/useExhaustiveDependencies: scheme is an invalidation key, not a value the body reads — canvas keeps its pixels, and the colours it drew with are custom properties that the OS theme changes underneath it.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)

    const cx = size / 2
    const cy = size / 2
    const radius = (size - strokeWidth) / 2
    const total = protein + carbs + fat

    ctx.lineWidth = strokeWidth
    // Abutting segments must not overlap at the joins, so no round caps.
    ctx.lineCap = 'butt'

    if (total <= 0) {
      // A meal with no macro data still gets a ring, just a dim one.
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.strokeStyle = resolveColor('var(--c-pie-empty)')
      ctx.stroke()
      return
    }

    let start = -Math.PI / 2
    for (const [value, color] of [
      [protein, proteinColor],
      [carbs, carbsColor],
      [fat, fatColor],
    ] as const) {
      if (value <= 0) continue
      const end = start + (value / total) * Math.PI * 2
      ctx.beginPath()
      ctx.arc(cx, cy, radius, start, end)
      ctx.strokeStyle = resolveColor(color)
      ctx.stroke()
      start = end
    }
  }, [protein, carbs, fat, proteinColor, carbsColor, fatColor, size, strokeWidth, scheme])

  return (
    <span aria-hidden="true" style={{ display: 'block', width: size, height: size }}>
      <canvas ref={canvasRef} style={{ width: size, height: size, display: 'block' }} />
    </span>
  )
}
