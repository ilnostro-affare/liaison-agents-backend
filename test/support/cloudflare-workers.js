// The minimum of the Workers runtime a Durable Object class needs in a unit test.
export class DurableObject {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
