// Resolve the Workers runtime module to a local shim, so Durable Object classes load in Node.
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: new URL("./cloudflare-workers.js", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
