export class ControlLock {
  private releaseLock?: () => void
  private held = false

  async acquire(): Promise<boolean> {
    if (this.held) return true
    if (!navigator.locks) {
      this.held = true
      return true
    }

    let reportAcquired!: (acquired: boolean) => void
    const acquired = new Promise<boolean>((resolve) => {
      reportAcquired = resolve
    })
    void navigator.locks.request(
      'ozobot-evo-motor-control',
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          reportAcquired(false)
          return
        }
        this.held = true
        reportAcquired(true)
        await new Promise<void>((resolve) => {
          this.releaseLock = resolve
        })
        this.releaseLock = undefined
        this.held = false
      },
    )
    return acquired
  }

  release(): void {
    this.releaseLock?.()
    if (!navigator.locks) {
      this.held = false
    }
  }
}

