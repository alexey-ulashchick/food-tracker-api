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

  await page.getByPlaceholder('Расскажи, что ты съел…').fill('съел яблоко')
  await page.keyboard.press('Enter')

  // The scripted turn calls add_meal, so the action card is what proves the
  // whole path — stream, tool execution, persistence, render.
  await expect(page.getByText('Добавлено')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Яблоко')).toBeVisible()

  // And the write is reflected on Today without a reload.
  await page.getByRole('link', { name: 'Сегодня' }).click()
  await expect(page.getByText('Яблоко')).toBeVisible({ timeout: 20_000 })
})

test('swiping the recommend deck does not move the page scroll', async ({ page }) => {
  await authenticate(page)
  await page.goto('/chat')

  await page.getByRole('button', { name: 'Рекомендация' }).click()

  // Either variants arrive or the no-goal card does; both end the turn.
  const deck = page.locator('.snap-deck')
  const noGoal = page.getByText('Сначала выстави цель', { exact: false })
  await expect(deck.or(noGoal).first()).toBeVisible({ timeout: 20_000 })

  if ((await deck.count()) === 0) {
    test.info().annotations.push({ type: 'note', description: 'no goal today — deck not shown' })
    return
  }

  const before = await page.evaluate(() => window.scrollY)
  await deck.first().evaluate((el) => {
    el.scrollBy({ left: 200 })
  })
  await page.waitForTimeout(300)
  // The horizontal scroller must not have dragged the page with it.
  expect(await page.evaluate(() => window.scrollY)).toBe(before)
})

test('tapping a History row opens that day on Today', async ({ page }) => {
  await authenticate(page)
  await page.goto('/history')

  await expect(page.getByRole('heading', { name: 'История' })).toBeVisible()

  const rows = page.locator('section button')
  await expect.poll(async () => await rows.count(), { timeout: 20_000 }).toBeGreaterThan(0)

  // The row's big number is the day of month; keep it to compare after.
  const day = (await rows.first().textContent())?.match(/\d+/)?.[0]
  await rows.first().click()

  await expect(page.getByRole('heading')).toBeVisible()
  // Today now shows a specific past day, so the reset pill appears.
  await expect(page.getByRole('button', { name: 'Сегодня' })).toBeVisible()
  if (day) {
    await expect(page.locator('body')).toContainText(day)
  }
})
