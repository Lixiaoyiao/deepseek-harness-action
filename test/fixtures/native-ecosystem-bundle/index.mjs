export const name = "native-ecosystem-bundle-fixture";
export const inject = ["tools"];

export function apply(ctx) {
  ctx.tools.register({
    name: "native_bundle_echo",
    description: "Return the native Profile Bundle fixture marker",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: { type: "string" },
      render: (_arguments, result) => [{ type: "text", text: result }],
    },
    execute: () => Promise.resolve("NATIVE_BUNDLE_MARKER"),
  });
}
