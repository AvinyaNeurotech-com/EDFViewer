export class TrendPacer {
  private worker: Worker | null = null
  private ready = false
  private waiting = false
  private startMessage: unknown = null
  private frame = 0

  setReady(ready: boolean) {
    this.ready = ready
    if (!ready) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
      if (this.startMessage === null) this.worker?.postMessage({ type: 'pause' })
    }
    else this.schedule()
  }

  start(worker: Worker, message: unknown) {
    this.worker = worker
    this.startMessage = message
    this.schedule()
  }

  wait(worker: Worker) {
    this.worker = worker
    this.waiting = true
    this.schedule()
  }

  clear() {
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.worker = null
    this.waiting = false
    this.startMessage = null
  }

  private schedule() {
    if (!this.ready || (!this.waiting && this.startMessage === null) || !this.worker || this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      if (!this.ready || (!this.waiting && this.startMessage === null) || !this.worker) return
      if (this.startMessage !== null) {
        this.worker.postMessage(this.startMessage)
        this.startMessage = null
        return
      }
      this.waiting = false
      this.worker.postMessage({ type: 'continue' })
    })
  }
}
