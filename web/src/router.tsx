import { AppLayout } from '@/components/AppLayout'
import { RequireToken } from '@/components/RequireToken'
import { Chat } from '@/screens/Chat'
import { History } from '@/screens/History'
import { Kitchen } from '@/screens/Kitchen'
import { Login } from '@/screens/Login'
import { Memories } from '@/screens/Memories'
import { Today } from '@/screens/Today'
import { Weight } from '@/screens/Weight'
import { You } from '@/screens/You'
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
        <Route path="chat" element={<Chat />} />
        <Route path="history" element={<History />} />
        <Route path="you" element={<You />} />
        <Route path="you/memories" element={<Memories />} />
        <Route path="you/weight" element={<Weight />} />
      </Route>

      {/* Anything unknown lands on Today rather than a blank page. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
