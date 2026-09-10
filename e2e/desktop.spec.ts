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

  // The calorie chart is a scrolling strip, so viewBox == rendered box is
  // tautological for it: one measured number feeds both. What is worth pinning
  // is the density — a fixed day column sized so the visible part still shows
  // the month the SwiftUI original did, however much history sits behind it.
  const strip = page.locator('.chart-strip')
  await expect(strip).toBeVisible({ timeout: 20_000 })

  const density = await strip.evaluate((el) => {
    const svg = el.querySelector('svg')
    const bars = el.querySelectorAll('rect').length
    const contentW = Number.parseFloat(svg?.getAttribute('width') ?? '0')
    return { visibleDays: (el.clientWidth / contentW) * bars, bars }
  })
  expect(density.bars).toBeGreaterThan(29)
  expect(density.visibleDays).toBeGreaterThan(27)
  expect(density.visibleDays).toBeLessThan(31)

  // Weight is still a fitted chart, so there the check means something: a
  // viewBox that disagrees with the box is a curve smeared horizontally.
  await page.goto('/you/weight')
  const weight = page.locator('svg[aria-label="График веса по неделям"]')
  if ((await weight.count()) > 0) {
    await expectViewBoxMatchesBox(weight)
  } else {
    test.info().annotations.push({ type: 'note', description: 'no weight data' })
  }
})

test('the chart strip loads older days instead of paging', async ({ page }) => {
  await authenticate(page)
  await page.goto('/history')

  const strip = page.locator('.chart-strip')
  await expect(strip).toBeVisible({ timeout: 20_000 })

  // The two paginator buttons are gone; scrolling is the whole interface.
  await expect(page.getByRole('button', { name: 'Раньше' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Позже' })).toHaveCount(0)

  // It opens at today, which is the right-hand end.
  const opened = await strip.evaluate((el) => ({
    left: el.scrollLeft,
    max: el.scrollWidth - el.clientWidth,
    bars: el.querySelectorAll('rect').length,
  }))
  expect(opened.max).toBeGreaterThan(0)
  expect(opened.left).toBeGreaterThan(opened.max - 2)

  // Reaching the left edge asks for the page before it, and the anchor then has
  // to hold the view still. A jump further back in time on every page is the
  // thing most likely to go wrong here, so scrollLeft is checked after.
  await strip.evaluate((el) => el.scrollTo({ left: 0 }))
  await expect
    .poll(async () => await strip.evaluate((el) => el.querySelectorAll('rect').length), {
      timeout: 20_000,
    })
    .toBeGreaterThan(opened.bars)

  expect(await strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)

  // And the way home appears once we are away from today.
  await expect(page.getByRole('button', { name: 'Сегодня' })).toBeVisible()
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

test('the classes that restyle a block actually win over its inline style', async ({ page }) => {
  await authenticate(page)
  await page.goto('/')

  // The failure mode this guards is silent and specific to how this app is
  // built: almost every element carries an inline style={{}}, and an inline
  // declaration beats any class rule. A layout class whose property is also set
  // inline simply does nothing, at any width, with nothing thrown. Computed
  // values are the only way to tell.
  const mealText = page.locator('.meal-text').first()
  if ((await mealText.count()) > 0) {
    await expect(mealText).toHaveCSS('flex-direction', 'row')
  } else {
    test.info().annotations.push({ type: 'note', description: 'no meals logged today' })
  }

  await page.goto('/you/memories')
  const grid = page.locator('.memory-grid')
  if ((await grid.count()) > 0) {
    await expect(grid).toHaveCSS('display', 'grid')
  } else {
    test.info().annotations.push({ type: 'note', description: 'no memories saved' })
  }
})

test('the chat column bounds its bars and its header together', async ({ page }) => {
  await authenticate(page)
  await page.goto('/chat')
  await expect(page.getByRole('heading', { name: 'Чат' })).toBeVisible()

  // The first pass measured the inside of each .material-thin band and left the
  // bands themselves full-bleed, which put a 720px island of content in the
  // middle of a long empty grey field — and left the screen header, which is in
  // no band at all, hanging to the left of everything else. All four edges are
  // asserted together because that is the failure: they disagreed.
  const column = page.locator('.chat-column')
  const strip = page.locator('.material-thin').first()
  const composer = page.locator('.material-thin').last()
  const header = page.getByRole('heading', { name: 'Чат' })

  const edges = await Promise.all(
    [column, strip, composer, header].map((l) => l.evaluate((el) => el.getBoundingClientRect().x)),
  )
  const [columnLeft, stripLeft, composerLeft, headerLeft] = edges as [
    number,
    number,
    number,
    number,
  ]

  expect(stripLeft).toBe(columnLeft)
  expect(composerLeft).toBe(columnLeft)
  // The header carries the page padding, so it is inset from the column edge
  // rather than flush with it — but by a page padding, not by 70px of drift.
  expect(headerLeft - columnLeft).toBeLessThanOrEqual(32)

  // And the column is narrower than the pane it sits in, or none of the above
  // would mean anything.
  const paneWidth = await page.locator('main').evaluate((el) => el.getBoundingClientRect().width)
  const columnWidth = await column.evaluate((el) => el.getBoundingClientRect().width)
  expect(columnWidth).toBeLessThan(paneWidth)
})

test('Профиль stays a single column', async ({ page }) => {
  await authenticate(page)
  await page.goto('/you')
  await expect(page.getByRole('heading', { name: 'Профиль' })).toBeVisible()

  // Two-up scattered the section labels into the right-hand column and left a
  // ragged gap under the shorter card. Every block shares a left edge now.
  const blocks = page.locator('.settings-column > .card-block')
  await expect(blocks).toHaveCount(4)

  const lefts = await blocks.evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().left)),
  )
  expect(new Set(lefts).size).toBe(1)
})

test('the type scale shrinks the text without touching the phone values', async ({ page }) => {
  await authenticate(page)
  await page.goto('/')

  // Every inline size is calc(Npx * var(--type)); this is the only place the
  // multiplier is proven to arrive. A meal name is 14.5px at --type: 1.
  const name = page.locator('.meal-name').first()
  if ((await name.count()) === 0) {
    test.info().annotations.push({ type: 'note', description: 'no meals logged today' })
    return
  }

  const size = await name.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
  expect(size).toBeGreaterThan(11.5)
  expect(size).toBeLessThan(13)

  // And the page title moves with it rather than staying at its phone size.
  const title = await page
    .getByRole('heading', { level: 1 })
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
  expect(title).toBeLessThan(32)
  expect(title).toBeGreaterThan(24)
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

test.describe('light mode', () => {
  // The only place the light theme is proven at all: jsdom evaluates no media
  // queries and vitest blanks CSS, so every unit test sees the dark base.
  test.use({ colorScheme: 'light' })

  test('follows the OS and repaints the canvas rings with it', async ({ page }) => {
    await authenticate(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Сегодня' })).toBeVisible()

    const card = page.locator('.card-row--today > section').first()
    await expect(card).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(242, 242, 247)')
    // Black text, not the white the dark theme uses.
    await expect(page.getByRole('heading', { level: 1 })).toHaveCSS('color', 'rgb(0, 0, 0)')

    // The rings are canvas, which keeps its pixels until something redraws them.
    // A non-blank canvas over a white card is the only evidence available that
    // the palette was re-resolved rather than left at its dark values.
    const drawn = await page
      .locator('canvas')
      .first()
      .evaluate((el) => {
        const canvas = el as HTMLCanvasElement
        const ctx = canvas.getContext('2d')
        if (!ctx) return null
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
        let painted = 0
        for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) painted++
        return painted
      })
    expect(drawn).not.toBeNull()
    expect(drawn!).toBeGreaterThan(0)
  })

  test("the chat's material bar follows too", async ({ page }) => {
    await authenticate(page)
    await page.goto('/chat')
    await expect(page.getByRole('heading', { name: 'Чат' })).toBeVisible()

    // .material-thin is the one surface with its own token rather than a card
    // colour, so it is the one most likely to be forgotten. Light is
    // rgba(250,250,250,0.72); the dark value starts at 37, which is what a
    // stale token would report here.
    const composer = page.locator('.material-thin').last()
    const material = await composer.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(material).toMatch(/^rgba\(2[45]\d, 2[45]\d, 2[45]\d/)

    // And the text it holds is black, not the white the dark theme uses — the
    // clearest single signal that the token layer switched rather than just the
    // page background.
    const field = page.getByPlaceholder('Расскажи, что ты съел…')
    await expect(field).toHaveCSS('color', 'rgb(0, 0, 0)')
  })
})
