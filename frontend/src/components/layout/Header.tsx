import { NavLink } from 'react-router-dom'
import { clsx } from 'clsx'

const TABS = [
  { to: '/schedules', label: 'Schedules' },
  { to: '/reports', label: 'Resolution Time' },
]

export function Header() {
  return (
    <header className="border-b border-[var(--color-hairline)] bg-[var(--color-surface)]">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-8 px-6">
        <div className="flex items-baseline gap-2">
          <span className="font-[family-name:var(--font-display)] text-[17px] font-bold tracking-tight text-[var(--color-ink-900)]">
            Richpanel
          </span>
          <span className="text-[13px] text-[var(--color-ink-500)]">Workforce</span>
        </div>

        <nav className="flex items-center gap-1" aria-label="Main">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                clsx(
                  'rounded-[var(--radius-md)] px-3 py-1.5 text-[13px] font-medium transition-colors',
                  isActive
                    ? 'bg-[var(--color-brand-100)] text-[var(--color-brand)]'
                    : 'text-[var(--color-ink-500)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-ink-900)]',
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>

        {/* Times are IST system-wide and there is no timezone picker by design —
            saying so once here prevents every screen from having to explain it. */}
        <span className="ml-auto text-[11px] font-medium tracking-wide text-[var(--color-ink-400)] uppercase">
          All times IST
        </span>
      </div>
    </header>
  )
}
