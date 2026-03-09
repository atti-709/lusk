import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { CancelPromptProvider } from './contexts/CancelPromptContext'
import { AppSettingsProvider } from './contexts/AppSettingsContext'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppSettingsProvider>
      <CancelPromptProvider>
        <App />
      </CancelPromptProvider>
    </AppSettingsProvider>
  </StrictMode>,
)
