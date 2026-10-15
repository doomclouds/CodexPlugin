export type CheckpointRelease = () => Promise<void>;

function interrupted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Workflow interrupted", "AbortError");
}

/** Keeps checkpoint capture outside every active worker's side-effect window. */
export class StableCheckpointGate {
  private active = 0;
  private capturing: Promise<void> | undefined;
  private failure: { error: unknown } | undefined;
  private readonly onStable: () => Promise<void>;

  constructor(onStable: () => Promise<void>) {
    this.onStable = onStable;
  }

  async enter(signal: AbortSignal): Promise<CheckpointRelease> {
    this.check(signal);
    while (this.capturing) {
      await this.wait(this.capturing, signal);
      this.check(signal);
    }

    // There is no await between observing an open gate and claiming this slot.
    this.active++;
    let released: Promise<void> | undefined;
    return () => {
      if (released) return released;
      let complete!: () => void;
      let fail!: (error: unknown) => void;
      released = new Promise<void>((resolve, reject) => {
        complete = resolve;
        fail = reject;
      });
      // Record ownership release before leave can invoke a reentrant callback.
      this.leave().then(complete, fail);
      return released;
    };
  }

  private check(signal: AbortSignal): void {
    if (this.failure) throw this.failure.error;
    if (signal.aborted) throw interrupted(signal);
  }

  private wait(capture: Promise<void>, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: { value: unknown }) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (error) reject(error.value);
        else resolve();
      };
      const abort = () => finish({ value: interrupted(signal) });
      signal.addEventListener("abort", abort, { once: true });
      capture.then(() => finish(), error => finish({ value: error }));
      if (signal.aborted) abort();
    });
  }

  private leave(): Promise<void> {
    // Callers release only after their worker and attempt metadata have settled.
    this.active--;
    if (this.active !== 0) return Promise.resolve();

    let complete!: () => void;
    let fail!: (error: unknown) => void;
    const capture = new Promise<void>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    // Install the barrier before invoking user code, including synchronous throws
    // and callbacks that synchronously try to enter the next worker wave.
    this.capturing = capture;
    const failed = (error: unknown) => {
      this.failure = { error };
      this.capturing = undefined;
      fail(error);
    };
    try {
      Promise.resolve(this.onStable()).then(() => {
        this.capturing = undefined;
        complete();
      }, failed);
    } catch (error) {
      failed(error);
    }
    return capture;
  }
}
