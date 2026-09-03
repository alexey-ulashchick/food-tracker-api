import { Kitchen } from './screens/Kitchen'

// Routing, the app shell and the real screens arrive in later steps. Until
// then the entry point renders the component sandbox so the ring port can be
// compared against the iOS simulator.
export function App() {
  return <Kitchen />
}
