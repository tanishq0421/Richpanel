import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'

import App from './App'
import { ToastProvider } from './context/ToastContext'
import { queryClient } from './lib/queryClient'
import './styles/index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* ToastProvider must wrap the router: useToast() is called from route
          components and from modals, and a missing provider throws rather than
          degrading — which blanks the whole page, not just the toast. */}
      <ToastProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
