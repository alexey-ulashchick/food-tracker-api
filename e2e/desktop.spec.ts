import { type Locator, expect, test } from '@playwright/test'

// The desktop shell. Everything here is a claim about a media query, and no
// unit test can make one: jsdom evaluates no media queries at all, and vitest
// blanks CSS imports outright. This file is the only place the desktop layout
// is proven to exist.
//
// Runs in the desktop-safari project (1280x900, WebKit, no touch), which is
// what makes `(hover: hover) and (pointer: fine)` match.

const TOKEN = process.env.E2E_TOKEN ?? ''

test.skip(TOKEN === '', 'E2E_TOKEN is not set — mint one with `bun run issue-token`')

async function authenticate(page: import('@playwright/test').Page) {
  await page.addInitScript((token) => window.localStorage.setItem('caltracker.token', token), TOKEN)
}

test('the sidebar replaces the tab bar and carries every section', async ({ page }) => {
  await authenticate(page)
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Сегодня' })).toBeVisible()

  // Exactly one nav: the two surfaces are swapped, never both mounted with one
  // hidden, or every link would appear twice to a screen reader.
  await expect(page.getByRole('navigation')).toHaveCount(1)
  await expect(page.locator('.tab-bar')).toHaveCount(0)

  const links = page.getByRole('navigation').getByRole('link')
  await expect(links).toHaveText(['Сегодня', 'Чат', 'История', 'Вес', 'Память', 'Профиль'])
})

test('Профиль stops being active once a sub-screen of it is open', async ({ page }) => {
  await authenticate(page)
  await page.goto('/you/weight')

  await expect(page.getByRole('heading', { name: 'Вес' })).toBeVisible()
  const active = page.getByRole('navigation').locator('a[aria-current]')
  await expect(active).toHaveText(['Вес'])
})

test('the page widens past the phone column and stays capped', async ({ page }) => {
  await authenticate(page)
  await page.goto('/')

  const page_ = page.locator('.page').first()
  const width = await page_.evaluate((el) => el.getBoundingClientRect().width)

  // Wider than the 480 phone column, and not the full 1280 minus the sidebar
  // either — the content cap is what stops a meal row spanning a monitor.
  expect(width).toBeGreaterThan(480)
  expect(width).toBeLessThanOrEqual(1180)

  const padding = await page_.evaluate((el) => getComputedStyle(el).paddingLeft)
  expect(padding).toBe('28px')
})

test("Today's two cards sit side by side", async ({ page }) => {
  await authenticate(page)
  await page.goto('/')

  const cards = page.locator('.card-row--today > section')
  await expect(cards).toHaveCount(2)

  const [first, second] = await cards.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect()),
  )
  // Same row: the second starts to the right of the first, not below it.
  expect(second?.left).toBeGreaterThan(first?.left ?? 0)
  expect(Math.abs((second?.top ?? 0) - (first?.top ?? 0))).toBeLessThan(2)
})

test('both charts draw at the width they are given', async ({ page }) => {
  await authenticate(page)
  await page.goto('/history')

  // The one assertion that pins both measurement bugs at once. A viewBox that
  // disagrees with the rendered box means either a chart floating at its seed
  // width with dead space around it (CalorieChart's old useState(320)) or a
  // curve smeared horizontally (Weight's old preserveAspectRatio="none").
  const chart = page.locator('svg[aria-label="График калорий по дням"]')
  await expect(chart).toBeVisible({ timeout: 20_000 })
  await expectViewBoxMatchesBox(chart)

  await page.goto('/you/weight')
  const weight = page.locator('svg[aria-label="График веса по неделям"]')
  if ((await weight.count()) > 0) {
    await expectViewBoxMatchesBox(weight)
  } else {
    test.info().annotations.push({ type: 'note', description: 'no weight data — chart not shown' })
  }
})

test('the shell follows the window back down to a phone width', async ({ page }) => {
  await authenticate(page)
  await page.goto('/')
  await expect(page.locator('.tab-bar')).toHaveCount(0)

  // Proves the subscription, not just the first read — nothing in the unit
  // tests can observe the resize listener actually firing.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.tab-bar')).toHaveCount(1)
  await expect(page.getByRole('navigation')).toHaveCount(1)

  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(page.locator('.tab-bar')).toHaveCount(0)
})

test('Escape closes the attach menu', async ({ page }) => {
  await authenticate(page)
  await page.goto('/chat')

  const attach = page.getByRole('button', { name: 'Прикрепить фото' })
  await attach.click()
  await expect(page.getByRole('button', { name: 'Снять фото' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Снять фото' })).toHaveCount(0)
})

/** An SVG whose viewBox width differs from its rendered width is mis-measured. */
async function expectViewBoxMatchesBox(locator: Locator) {
  const { viewBoxWidth, boxWidth } = await locator.evaluate((el) => ({
    viewBoxWidth: Number(el.getAttribute('viewBox')?.split(/\s+/)[2] ?? 0),
    boxWidth: el.getBoundingClientRect().width,
  }))
  expect(viewBoxWidth).toBeGreaterThan(0)
  expect(Math.abs(viewBoxWidth - boxWidth)).toBeLessThan(2)
}
