// Base channel interface — all channel adapters extend this
export class BaseChannel {
  constructor(name, gateway) {
    this.name = name;
    this.gateway = gateway; // reference to gateway for submitting tasks
    this.running = false;
  }

  async start() {
    throw new Error('start() not implemented');
  }

  async stop() {
    this.running = false;
  }

  // Submit a task through the gateway
  async submitTask(taskDef) {
    return this.gateway.submitTask({
      ...taskDef,
      channel: this.name,
    });
  }

  // Called by gateway when task completes (for sending results back)
  async onTaskComplete(task) {
    /* override in subclass */
  }

  // Called by gateway when task fails (for sending errors back)
  async onTaskFailed(task) {
    /* override in subclass */
  }
}

export default BaseChannel;
