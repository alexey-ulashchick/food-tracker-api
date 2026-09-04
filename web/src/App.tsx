import { setUnauthorizedHandler } from '@/api/client'
import { createQueryClient } from '@/api/keys'
import { AppRoutes } from '@/router'
import { useUi } from '@/store/ui'
import { QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { BrowserRouter, useNavigate } from 'react-router'

export function App() {
  // One client for the app's lifetime; useState rather than a module constant so
  // it is not shared between test renders.
  const [queryClient] = useState(createQueryClient)

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <UnauthorizedRedirect />
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  )
}

/**
 * Turns a 401 from any request into a client-side redirect.
 *
 * api/client.ts cannot navigate on its own — it has no router — so it calls a
 * handler installed here. Going through the router rather than
 * location.assign() keeps the SPA from doing a full reload, which on a
 * scale-to-zero backend would mean waiting out a cold start just to see the
 * login screen.
 */
function UnauthorizedRedirect() {
  const navigate = useNavigate()
  const setError = useUi((s) => s.setError)

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setError('Токен отклонён сервером. Войди снова.')
      navigate('/login', { replace: true })
    })
    return () => setUnauthorizedHandler(() => {})
  }, [navigate, setError])

  return null
}
