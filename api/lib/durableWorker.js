"use strict";
const crypto = require("crypto");
class DurableWorker {
  constructor(
    store,
    handler,
    {
      concurrency = 2,
      leaseMs = 120000,
      pollMs = 1000,
      blockedTenants = () => [],
      clock = Date.now,
    } = {},
  ) {
    this.store = store;
    this.handler = handler;
    this.concurrency = concurrency;
    this.leaseMs = leaseMs;
    this.pollMs = pollMs;
    this.blockedTenants = blockedTenants;
    this.clock = clock;
    this.owner = crypto.randomUUID();
    this.active = new Map();
    this.stopping = false;
  }
  start() {
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref?.();
    this.tick();
    return this;
  }
  tick() {
    if (this.stopping) return;
    try {
      while (this.active.size < this.concurrency) {
        const job = this.store.claim(
          this.owner,
          this.clock(),
          this.leaseMs,
          this.blockedTenants(),
        );
        if (!job) break;
        const promise = this.run(job);
        this.active.set(job.id, promise);
        promise.then(
          () => this.active.delete(job.id),
          (e) => {
            this.active.delete(job.id);
            console.error("Durable Worker:", e.message);
          },
        );
      }
    } catch (e) {
      console.error("Durable Worker:", e.message);
    }
  }
  async run(job) {
    const controller = new AbortController();
    let lost = false;
    const heartbeat = setInterval(
      () => {
        try {
          if (
            !this.store.heartbeat(
              job.id,
              this.owner,
              this.clock(),
              this.leaseMs,
            )
          ) {
            lost = true;
            controller.abort();
          }
        } catch {
          lost = true;
          controller.abort();
        }
      },
      Math.max(1000, Math.floor(this.leaseMs / 3)),
    );
    heartbeat.unref?.();
    try {
      const result = await this.handler(job, {
        owner: this.owner,
        signal: controller.signal,
        progress: (summary, checkpoint) => {
          if (lost) throw new Error("Worker-Lease verloren.");
          this.store.progress(job.id, this.owner, summary, checkpoint);
        },
      });
      if (!lost)
        this.store.finish(
          job.id,
          this.owner,
          result?.partial ? "partial" : "done",
          result?.warning || null,
        );
    } catch (e) {
      if (!lost) {
        const transient =
          e.retryable === true ||
          e.status === 429 ||
          e.status >= 500 ||
          /fetch failed|ECONNRESET|ETIMEDOUT/.test(e.message);
        this.store.finish(
          job.id,
          this.owner,
          transient ? "retry" : "failed",
          String(e.message).slice(0, 2000),
          Math.min(300000, 5000 * 2 ** (job.attempts - 1)),
        );
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.active.values());
  }
}
module.exports = { DurableWorker };
