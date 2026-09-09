import { NAV, NAV_GROUPS, needsEnd } from '@/nav'
import { accent, label } from '@/theme/tokens'
import { NavLink } from 'react-router'

// The desktop navigation. Replaces the tab bar above the breakpoint rather than
// sitting alongside it — two mounted <nav>s would mean two copies of every link
// in the accessibility tree, which is both wrong for a screen reader and enough
// to break every by-role query in the tests.
//
// Grouped, because the reason to build a sidebar at all was room to grow: a new
// section is a row in nav.ts, and it lands under its heading here.

export function Sidebar() {
  return (
    <nav className="sidebar" aria-label="Разделы">
      <span className="sidebar-brand">Cal Tracker</span>

      {NAV_GROUPS.map(({ id, heading }) => {
        const items = NAV.filter((i) => i.group === id)
        if (items.length === 0) return null

        return (
          <div key={id} className="sidebar-group">
            {heading ? <span className="sidebar-heading">{heading}</span> : null}
            {items.map(({ to, label: text, Icon }) => (
              <NavLink
                key={to}
                to={to}
                // Derived per surface: the sidebar lists Профиль next to Вес and
                // Память, so `/you` must not stay lit while a child is open.
                end={needsEnd(to)}
                className="nav-item"
                style={({ isActive }) => ({
                  color: isActive ? accent : label.secondary,
                  background: isActive ? 'var(--nav-bg-active)' : 'var(--nav-bg, transparent)',
                })}
              >
                <Icon size={20} />
                <span>{text}</span>
              </NavLink>
            ))}
          </div>
        )
      })}
    </nav>
  )
}
