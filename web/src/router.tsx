import { AppLayout } from '@/components/AppLayout'
import { RequireToken } from '@/components/RequireToken'
import { History } from '@/screens/History'
import { Kitchen } from '@/screens/Kitchen'
import { Login } from '@/screens/Login'
import { Placeholder } from '@/screens/Placeholder'
import { Today } from '@/screens/Today'
import { Navigate, Route, Routes } from 'react-router'

// Routes mirror the four live tabs plus the two screens You pushes.
// `/dev/kitchen` is the component sandbox and is registered in dev only.

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      {import.meta.env.DEV ? <Route path="/dev/kitchen" element={<Kitchen />} /> : null}

      <Route
        element={
          <RequireToken>
            <AppLayout />
          </RequireToken>
        }
      >
        <Route index element={<Today />} />
        <Route
          path="chat"
          element={<Placeholder title="Чат" note="Экран появится на шаге 22." />}
        />
        <Route path="history" element={<History />} />
        <Route
          path="you"
          element={<Placeholder title="Профиль" note="Экран появится на шаге 23." />}
        />
        <Route
          path="you/memories"
          element={<Placeholder title="Память" note="Экран появится на шаге 23." />}
        />
        <Route
          path="you/weight"
          element={<Placeholder title="Вес" note="Экран появится на шаге 23." />}
        />
      </Route>

      {/* Anything unknown lands on Today rather than a blank page. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
