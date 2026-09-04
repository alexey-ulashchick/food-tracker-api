import type { TurnUsage } from './chatMapper'

/**
 * Cost/token label shown above an ai bubble. Port of CostDisplayMode in
 * Models.swift:256.
 *
 * Four decimals catch the sub-cent cost of a typical chat turn; three are
 * enough once it passes a cent.
 */

export type CostDisplayMode = 'none' | 'dollars' | 'tokens' | 'both'

export const COST_DISPLAY_MODES: CostDisplayMode[] = ['none', 'dollars', 'tokens', 'both']

export const COST_DISPLAY_LABELS: Record<CostDisplayMode, string> = {
  none: 'Выкл',
  dollars: 'Доллары',
  tokens: 'Токены',
  both: 'Оба',
}

export function formatDollars(costUsd: number): string {
  return costUsd >= 0.01 ? `$${costUsd.toFixed(3)}` : `$${costUsd.toFixed(4)}`
}

export function formatTokens(usage: TurnUsage): string {
  return `${usage.inputTokens}→${usage.outputTokens} tok`
}

export function renderCost(mode: CostDisplayMode, usage: TurnUsage | undefined): string | null {
  if (!usage || mode === 'none') return null
  switch (mode) {
    case 'dollars':
      return formatDollars(usage.costUsd)
    case 'tokens':
      return formatTokens(usage)
    case 'both':
      return `${formatDollars(usage.costUsd)} · ${formatTokens(usage)}`
  }
}
