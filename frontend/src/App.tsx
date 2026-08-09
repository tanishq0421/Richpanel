import { Navigate, Route, Routes } from 'react-router-dom'
import { Header } from '@/components/layout/Header'

function Placeholder({ title }: { title: string }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-10">
      <h1 className="font-[family-name:var(--font-display)] text-[20px] font-semibold text-[var(--color-ink-900)]">
        {title}
      </h1>
      <p className="mt-2 text-[13px] text-[var(--color-ink-500)]">Not built yet.</p>
    </div>
  )
}

export default function App() {
  return (
    <div className="min-h-screen bg-[var(--color-surface-sunken)]">
      <Header />
      <main className="mx-auto max-w-[1400px] px-6 py-8">
        <Routes>
          <Route path="/" element={<Navigate to="/schedules" replace />} />
          <Route path="/schedules" element={<Placeholder title="Schedule Configuration" />} />
          <Route path="/reports" element={<Placeholder title="Resolution Time Report" />} />
        </Routes>
      </main>
    </div>
  )
}
