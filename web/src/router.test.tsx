import { setToken } from '@/api/client'
import { createQueryClient } from '@/api/keys'
import { AppRoutes } from '@/router'
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// Guards the auth gate and the tab shell. The screens themselves are still
// placeholders, so these assert routing behaviour rather than content.

const VALID_TOKEN = `ft_${'a'.repeat(64)}`

function renderAt(path: string) {
  const client = createQueryClient()
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
})

afterEach(() => {
  localStorage.clear()
})

describe('routing without a token', () => {
  test('the root redirects to the login screen', () => {
    renderAt('/')
    expect(screen.getByRole('heading', { name: 'Cal Tracker' })).toBeInTheDocument()
  })

  test.each(['/chat', '/history', '/you', '/you/memories', '/you/weight'])(
    '%s redirects to the login screen',
    (path) => {
      renderAt(path)
      expect(screen.getByRole('heading', { name: 'Cal Tracker' })).toBeInTheDocument()
    },
  )

  test('the login screen itself is reachable', () => {
    renderAt('/login')
    expect(screen.getByPlaceholderText('ft_…')).toBeInTheDocument()
  })

  test('no tab bar is shown while unauthenticated', () => {
    renderAt('/')
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })
})

describe('routing with a token', () => {
  beforeEach(() => {
    setToken(VALID_TOKEN)
  })

  test('the root renders Today inside the shell', () => {
    renderAt('/')
    expect(screen.getByRole('heading', { name: 'Сегодня' })).toBeInTheDocument()
    expect(screen.getByRole('navigation')).toBeInTheDocument()
  })

  test.each([
    ['/chat', 'Чат'],
    ['/history', 'История'],
    ['/you', 'Профиль'],
    ['/you/memories', 'Память'],
    ['/you/weight', 'Вес'],
  ])('%s renders its own screen', (path, heading) => {
    renderAt(path)
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
  })

  test('the tab bar carries exactly the four live tabs', () => {
    renderAt('/')
    const links = screen.getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual(['Сегодня', 'Чат', 'История', 'Профиль'])
  })

  // Badges existed in RootView.swift but its tab was commented out.
  test('there is no Badges tab', () => {
    renderAt('/')
    expect(screen.queryByText('Награды')).not.toBeInTheDocument()
    expect(screen.queryByText('Badges')).not.toBeInTheDocument()
  })

  // Without `end` on the root NavLink it would match every path and light up
  // permanently.
  test('only the current tab is marked active', () => {
    renderAt('/history')
    const active = screen.getAllByRole('link').filter((l) => l.getAttribute('aria-current'))
    expect(active).toHaveLength(1)
    expect(active[0]?.textContent).toBe('История')
  })

  test('the root tab is not active while another tab is open', () => {
    renderAt('/chat')
    const today = screen.getAllByRole('link').find((l) => l.textContent === 'Сегодня')
    expect(today?.getAttribute('aria-current')).toBeNull()
  })

  test('an unknown path falls back to Today rather than a blank page', () => {
    renderAt('/nonsense')
    expect(screen.getByRole('heading', { name: 'Сегодня' })).toBeInTheDocument()
  })
})

describe('the shell above the desktop breakpoint', () => {
  beforeEach(() => {
    setToken(VALID_TOKEN)
    // Stands in for the media query flipping --desktop to 1. jsdom evaluates no
    // media queries, so this is the only way to reach the desktop branch.
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '1' }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('there is still exactly one navigation landmark', () => {
    renderAt('/')
    // The decisive constraint: the sidebar REPLACES the tab bar. Mounting both
    // and hiding one with CSS would duplicate every link in the accessibility
    // tree — and in jsdom, where CSS is blanked, would not even hide it.
    expect(screen.getAllByRole('navigation')).toHaveLength(1)
  })

  test('the sidebar carries every section, not just the four tabs', () => {
    renderAt('/')
    const links = screen.getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual([
      'Сегодня',
      'Чат',
      'История',
      'Вес',
      'Память',
      'Профиль',
    ])
  })

  test('Профиль does not stay lit while one of its sub-screens is open', () => {
    // The sidebar lists Вес next to Профиль, so /you needs the strict match the
    // tab bar deliberately does without.
    renderAt('/you/weight')
    const active = screen.getAllByRole('link').filter((l) => l.getAttribute('aria-current'))
    expect(active.map((l) => l.textContent)).toEqual(['Вес'])
  })
})
