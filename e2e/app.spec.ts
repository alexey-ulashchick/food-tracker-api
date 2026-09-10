import { expect, test } from '@playwright/test'

// The four paths the plan calls out. Each drives the real stack: Bun serving the
// built SPA on one origin, Postgres behind it, and the LLM stubbed by
// E2E_FAKE_LLM so a chat turn costs nothing.
//
// The token comes from E2E_TOKEN, minted by the CI job (or by
// `bun run issue-token` locally).

const TOKEN = process.env.E2E_TOKEN ?? ''

test.skip(TOKEN === '', 'E2E_TOKEN is not set — mint one with `bun run issue-token`')

/** Puts the token in place before the app boots, skipping the login form. */
async function authenticate(page: import('@playwright/test').Page) {
  await page.addInitScript((token) => window.localStorage.setItem('caltracker.token', token), TOKEN)
}

test('logging in with a token lands on Today', async ({ page }) => {
  await page.goto('/')
  // No token yet, so the guard sends us to the login form.
  await expect(page.getByRole('heading', { name: 'Cal Tracker' })).toBeVisible()

  await page.getByPlaceholder('ft_…').fill(TOKEN)
  await page.getByRole('button', { name: 'Войти' }).click()

  await expect(page.getByRole('heading', { name: 'Сегодня' })).toBeVisible()
  // The rings are canvases, so their presence is the assertion available.
  await expect(page.locator('canvas').first()).toBeVisible()
  await expect(page.getByRole('navigation')).toBeVisible()
})

test('a chat turn streams deltas and lands a meal card', async ({ page }) => {
  await authenticate(page)
  await page.goto('/chat')

  await expect(page.getByRole('heading', { name: 'Чат' })).toBeVisible()

  // A retry replays this turn against a database that still holds the previous
  // attempt's apple, so the assertions below count from whatever the history
  // already contains instead of expecting exactly one. No stream is open yet,
  // so the page really does reach network idle here.
  await page.waitForLoadState('networkidle')
  const cards = page.getByTestId('action-card').filter({ hasText: 'Добавлено' })
  const cardsBefore = await cards.count()

  await page.getByPlaceholder('Расскажи, что ты съел…').fill('съел яблоко')
  await page.keyboard.press('Enter')

  // The scripted turn calls add_meal, so a new action card is what proves the
  // whole path — stream, tool execution, persistence, render. The food name is
  // matched inside the card: on its own it also hits the user's own message and
  // the model's recap, which is what made an earlier version of this ambiguous.
  await expect(cards).toHaveCount(cardsBefore + 1, { timeout: 20_000 })
  await expect(cards.last()).toContainText('Яблоко')

  // And the write is reflected on Today without a reload.
  await page.getByRole('link', { name: 'Сегодня' }).click()
  await expect(page.getByTestId('meal-row').filter({ hasText: 'Яблоко' }).first()).toBeVisible({
    timeout: 20_000,
  })
})

test('swiping the recommend deck does not move the page scroll', async ({ page }) => {
  await authenticate(page)
  await page.goto('/chat')

  await page.getByRole('button', { name: 'Рекомендация' }).click()

  // Either variants arrive or the no-goal card does; both end the turn. The
  // card used to be erased a moment after it rendered — /chat/recommend gives
  // up on a missing goal before persisting anything, so the refetch that ends
  // a turn had nothing to replace it with. See reset() in useChatStream.
  const deck = page.locator('.snap-deck')
  const noGoal = page.getByText('Сначала выстави цель', { exact: false })
  await expect(deck.or(noGoal).first()).toBeVisible({ timeout: 20_000 })

  if ((await deck.count()) === 0) {
    test.info().annotations.push({ type: 'note', description: 'no goal today — deck not shown' })
    return
  }

  // Chat scrolls its own transcript, not the shell's pane, so that is what a
  // stray horizontal drag would move.
  const pane = page.locator('.chat-scroll')
  const before = await pane.evaluate((el) => el.scrollTop)
  await deck.first().evaluate((el) => {
    el.scrollBy({ left: 200 })
  })
  await page.waitForTimeout(300)
  // The horizontal scroller must not have dragged the transcript with it.
  expect(await pane.evaluate((el) => el.scrollTop)).toBe(before)
})

test('tapping a History row opens that day on Today', async ({ page }) => {
  await authenticate(page)
  await page.goto('/history')

  await expect(page.getByRole('heading', { name: 'История' })).toBeVisible()

  // Addressed by test id, not `section button`: the chart card above is also a
  // <section> and its paginator buttons come first, so the old selector clicked
  // "Раньше" and then passed on the reset pill THAT produces — never touching
  // the navigation this test is named after.
  const rows = page.getByTestId('past-day')
  await expect.poll(async () => await rows.count(), { timeout: 20_000 }).toBeGreaterThan(0)

  // The row's big number is the day of month; keep it to compare after.
  const day = (await rows.first().textContent())?.match(/\d+/)?.[0]
  await rows.first().click()

  // Today, showing a past day — which is what puts the reset pill on screen.
  // The title is a weekday name here, so the pill is the assertion that means
  // something.
  await expect(page.getByRole('button', { name: 'Сегодня' })).toBeVisible()
  await expect(page.locator('canvas').first()).toBeVisible()
  if (day) {
    await expect(page.locator('body')).toContainText(day)
  }
})

test('the phone shell keeps its own metrics', async ({ page }) => {
  await authenticate(page)
  await page.goto('/')

  // The guard on moving five screen roots into one .page class: if the class
  // fails to land, every screen goes edge to edge and nothing throws.
  const shell = page.locator('.page').first()
  const padding = await shell.evaluate((el) => {
    const s = getComputedStyle(el)
    return { left: s.paddingLeft, top: s.paddingTop, bottom: s.paddingBottom, gap: s.rowGap }
  })
  expect(padding).toEqual({ left: '16px', top: '8px', bottom: '24px', gap: '14px' })

  // The tab bar is the phone's nav, and it is the only one.
  await expect(page.getByRole('navigation')).toHaveCount(1)
  await expect(page.locator('.tab-bar')).toHaveCount(1)

  // Same viewBox check as the desktop spec: a chart must draw at its real
  // width on a phone too.
  await page.goto('/history')
  const chart = page.locator('svg[aria-label="График калорий по дням"]')
  await expect(chart).toBeVisible({ timeout: 20_000 })
  const { viewBoxWidth, boxWidth } = await chart.evaluate((el) => ({
    viewBoxWidth: Number(el.getAttribute('viewBox')?.split(/\s+/)[2] ?? 0),
    boxWidth: el.getBoundingClientRect().width,
  }))
  expect(viewBoxWidth).toBeGreaterThan(0)
  expect(Math.abs(viewBoxWidth - boxWidth)).toBeLessThan(2)
})
