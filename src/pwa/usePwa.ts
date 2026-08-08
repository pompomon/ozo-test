import { useCallback, useEffect, useRef, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export interface PwaState {
  readonly canInstall: boolean
  readonly updateAvailable: boolean
  readonly install: () => Promise<void>
  readonly applyUpdate: () => void
}

export function usePwa(motorsArmed: boolean): PwaState {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent>()
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>()
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const reloadForUpdate = useRef(false)

  useEffect(() => {
    const capturePrompt = (event: Event): void => {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', capturePrompt)
    return () => window.removeEventListener('beforeinstallprompt', capturePrompt)
  }, [])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    let disposed = false
    const activateUpdate = (): void => {
      if (reloadForUpdate.current) window.location.reload()
    }
    navigator.serviceWorker.addEventListener('controllerchange', activateUpdate)
    const watchRegistration = (next: ServiceWorkerRegistration): void => {
      if (disposed) return
      setRegistration(next)
      if (next.waiting) setUpdateAvailable(true)
      next.addEventListener('updatefound', () => {
        const worker = next.installing
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            setUpdateAvailable(true)
          }
        })
      })
    }
    void navigator.serviceWorker.register('./sw.js').then(watchRegistration).catch(() => undefined)
    return () => {
      disposed = true
      navigator.serviceWorker.removeEventListener('controllerchange', activateUpdate)
    }
  }, [])

  const install = useCallback(async (): Promise<void> => {
    if (!installPrompt) return
    await installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(undefined)
  }, [installPrompt])

  const applyUpdate = useCallback((): void => {
    if (motorsArmed) return
    reloadForUpdate.current = true
    registration?.waiting?.postMessage({ type: 'SKIP_WAITING' })
    setUpdateAvailable(false)
  }, [motorsArmed, registration])

  return {
    canInstall: Boolean(installPrompt),
    updateAvailable,
    install,
    applyUpdate,
  }
}
