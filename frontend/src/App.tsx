import { Navigate, Route, Routes } from 'react-router-dom'

import { Header } from '@/components/layout/Header'
import { ReportsPage } from '@/pages/reports/ReportsPage'
import { SchedulesPage } from '@/pages/schedules/SchedulesPage'

export default function App() {
  return (
    <div className="min-h-screen bg-[var(--color-surface-sunken)]">
      <Header />
      <main className="mx-auto max-w-[1400px] px-6 py-8">
        <Routes>
          <Route path="/" element={<Navigate to="/schedules" replace />} />
          {/* Both schedule routes render the same master–detail screen; the id
              selects the pane on the right rather than swapping the page. */}
          <Route path="/schedules" element={<SchedulesPage />} />
          <Route path="/schedules/:id" element={<SchedulesPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/reports/:id" element={<ReportsPage />} />
          {/* An unknown URL is a mistyped link, not a dead end. */}
          <Route path="*" element={<Navigate to="/schedules" replace />} />
        </Routes>
      </main>
    </div>
  )
}
