import { Sidebar } from '@/components/Sidebar'
import { useIsDesktop } from '@/lib/useIsDesktop'
import { TAB_ITEMS } from '@/nav'
import { useUi } from '@/store/ui'
import { WarnCircleIcon } from '@/theme/icons'
import { accent, label, surface, withAlpha } from '@/theme/tokens'
import { NavLink, Outlet } from 'react-router'

// The app shell: the viewport frame, one scroll pane, one global error banner,
// and one navigation surface — a tab bar at the foot on a phone, a sidebar down
// the side on a desktop.
//
// Nothing here is `position: fixed`. The frame (#root) is sized to the visual
// viewport by trackViewport(), so the bar is simply the last child of a flex
// column — it cannot drift behind the keyboard or strand itself mid-screen the
// way a fixed bottom bar does on iOS.
//
// The two navs are swapped, never both mounted and one hidden: a hidden copy
// still duplicates every link in the accessibility tree.
//
// Sections live in nav.ts. The Badges tab existed in RootView.swift but its tab
// was commented out, so it is not ported.

/**
 * Icon plus caption need about 52; the rest is clearance from the bottom edge.
 *
 * One height with the row centred inside it, rather than 52 plus bottom padding:
 * padding pushed the row to the top of the bar, leaving it visibly off-centre.
 * Not the full env(safe-area-inset-bottom) either — reserving all 34pt of the
 * home-indicator area read as a gap below the app, because the bar's material is
 * nearly black over a black background and the reserve did not look like part of
 * the bar.
 */
const TAB_BAR_HEIGHT = 68

export function AppLayout() {
  const isDesktop = useIsDesktop()

  return (
    // .app-shell rather than an inline maxWidth: a media query cannot widen an
    // inline declaration, and widening this frame is the whole desktop story.
    <div className="app-shell">
      {/* Pays back the notch inset the viewport-fit=cover layout reaches into.
          Part of the frame rather than of the scrolled content, so a screen's
          sticky header stops below the notch instead of sliding under it. */}
      <div className="safe-top" style={{ flexShrink: 0 }} />

      <ErrorBanner />

      {/* Only this row becomes a grid on a desktop. The frame around it stays a
          flex column so .safe-top, the banner and the tab bar keep the exact
          height relationships five commits of iOS fixes settled on. */}
      <div className="shell-body">
        {/* First in the DOM so Tab reaches the content before the navigation;
            on a desktop the grid puts it back on the right visually. */}
        <main
          style={{
            flex: 1,
            minWidth: 0,
            // The app's only scroller. minHeight:0 is what lets it shrink inside
            // the column instead of pushing the tab bar off the bottom — and it
            // is just as load-bearing as a grid item, where min-height also
            // defaults to auto.
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            // No -webkit-overflow-scrolling: touch. It is redundant since iOS 13
            // and it promotes the pane to its own compositing layer, where WebKit
            // stops repainting text and backgrounds — canvas keeps drawing, so the
            // rings survive on an otherwise blank screen.
          }}
        >
          <Outlet />
        </main>

        {isDesktop ? <Sidebar /> : null}
      </div>

      {isDesktop ? null : <TabBar />}
    </div>
  )
}

function TabBar() {
  return (
    <nav
      className="material-thin tab-bar"
      style={{
        flexShrink: 0,
        borderTop: `0.5px solid ${surface.hairline}`,
      }}
    >
      <div
        style={{
          height: TAB_BAR_HEIGHT,
          display: 'grid',
          gridTemplateColumns: `repeat(${TAB_ITEMS.length}, 1fr)`,
        }}
      >
        {TAB_ITEMS.map(({ to, label: text, Icon }) => (
          <NavLink
            key={to}
            to={to}
            // `end` on the root tab only, or it would match every route. Not
            // needsEnd(): the bar has no Вес or Память entry, and iOS keeps
            // Профиль lit while one of its sub-screens is open.
            end={to === '/'}
            style={({ isActive }) => ({
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              textDecoration: 'none',
              color: isActive ? accent : label.secondary,
              WebkitTapHighlightColor: 'transparent',
            })}
          >
            <Icon size={24} />
            <span style={{ fontWeight: 500, fontSize: 10 }}>{text}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  )
}

function ErrorBanner() {
  const lastError = useUi((s) => s.lastError)
  const setError = useUi((s) => s.setError)
  if (!lastError) return null

  return (
    <div
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '10px 16px',
        background: withAlpha(accent, 0.18),
        fontWeight: 400,
        fontSize: 13,
      }}
    >
      <span style={{ color: accent, display: 'flex', paddingTop: 1 }}>
        <WarnCircleIcon size={15} />
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          // A raw API error is one long unbroken JSON string. Without a break
          // opportunity it widens the layout, and the whole app scrolls sideways.
          overflowWrap: 'anywhere',
          // Long enough to read, bounded so a wall of JSON cannot take the screen.
          maxHeight: '5.5em',
          overflowY: 'auto',
        }}
      >
        {lastError}
      </span>
      <button
        type="button"
        onClick={() => setError(null)}
        style={{
          background: 'none',
          border: 0,
          color: accent,
          fontWeight: 600,
          fontSize: 13,
          padding: 0,
          cursor: 'pointer',
        }}
      >
        Скрыть
      </button>
    </div>
  )
}
