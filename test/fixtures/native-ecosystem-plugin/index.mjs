export const name = "native-ecosystem-plugin-fixture";
export const inject = ["tools"];

export function apply(ctx, config) {
  ctx.tools.register({
    name: "native_plugin_echo",
    description: "Return the native direct Cordis Plugin fixture marker",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: { type: "string" },
      render: (_arguments, result) => [{ type: "text", text: result }],
    },
    execute: () => Promise.resolve(`NATIVE_PLUGIN_MARKER:${config.marker}`),
  });
}
