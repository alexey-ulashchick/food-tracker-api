import { useUi } from '@/store/ui'
import { WarnCircleIcon } from '@/theme/icons'
import { ChatTabIcon, HistoryTabIcon, TodayTabIcon, YouTabIcon } from '@/theme/icons'
import { accent, label, layout, surface, withAlpha } from '@/theme/tokens'
import { NavLink, Outlet } from 'react-router'

// The app shell: a phone-width column, a fixed bottom tab bar, and one global
// error banner.
//
// Four tabs, matching the live ones in RootView.swift. The Badges tab existed
// in the Swift source but was commented out, so it is not ported.

const TABS = [
  { to: '/', label: 'Сегодня', Icon: TodayTabIcon },
  { to: '/chat', label: 'Чат', Icon: ChatTabIcon },
  { to: '/history', label: 'История', Icon: HistoryTabIcon },
  { to: '/you', label: 'Профиль', Icon: YouTabIcon },
] as const

/** Tall enough for icon + caption, plus whatever the home indicator needs. */
const TAB_BAR_HEIGHT = 52

export function AppLayout() {
  return (
    <div
      style={{
        maxWidth: layout.maxWidth,
        margin: '0 auto',
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      {/* Pays back the notch inset the viewport-fit=cover layout reaches into. */}
      <div className="safe-top" />

      <ErrorBanner />

      <main
        style={{
          flex: 1,
          minWidth: 0,
          // Clear the tab bar and the home indicator below it.
          paddingBottom: `calc(${TAB_BAR_HEIGHT}px + env(safe-area-inset-bottom, 0px))`,
        }}
      >
        <Outlet />
      </main>

      <TabBar />
    </div>
  )
}

function TabBar() {
  return (
    <nav
      className="material-thin"
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        // The bar spans the viewport, but its contents stay inside the column.
        borderTop: `0.5px solid ${surface.hairline}`,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        zIndex: 10,
      }}
    >
      <div
        style={{
          maxWidth: layout.maxWidth,
          margin: '0 auto',
          height: TAB_BAR_HEIGHT,
          display: 'grid',
          gridTemplateColumns: `repeat(${TABS.length}, 1fr)`,
        }}
      >
        {TABS.map(({ to, label: text, Icon }) => (
          <NavLink
            key={to}
            to={to}
            // `end` on the root tab only, or it would match every route.
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
            <span style={{ font: '500 10px inherit' }}>{text}</span>
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
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '10px 16px',
        background: withAlpha(accent, 0.18),
        font: '400 13px inherit',
      }}
    >
      <span style={{ color: accent, display: 'flex', paddingTop: 1 }}>
        <WarnCircleIcon size={15} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{lastError}</span>
      <button
        type="button"
        onClick={() => setError(null)}
        style={{
          background: 'none',
          border: 0,
          color: accent,
          font: '600 13px inherit',
          padding: 0,
          cursor: 'pointer',
        }}
      >
        Скрыть
      </button>
    </div>
  )
}
