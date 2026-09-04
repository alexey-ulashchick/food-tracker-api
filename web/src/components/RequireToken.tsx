import { getToken } from '@/api/client'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'

/**
 * Blocks a route until a token is present.
 *
 * The token is only checked for presence here — validity is proven by the API,
 * and a rejected one triggers the 401 handler in api/client.ts, which clears it
 * and sends the user back here.
 */
export function RequireToken({ children }: { children: ReactNode }) {
  const location = useLocation()
  if (!getToken()) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <>{children}</>
}
