export const name = "official-profile-bundle-fixture";
export const inject = ["tools"];

function textTool(name, value) {
  return {
    name,
    description: `Official Profile Bundle fixture tool ${name}`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: { type: "string" },
      render: (_arguments, result) => [{ type: "text", text: result }],
    },
    execute: () => Promise.resolve(value),
  };
}

export function apply(ctx) {
  ctx.tools.register(textTool("plugin__fixture__allowed", "official-profile-bundle@1.2.3:allowed"));
  ctx.tools.register(
    textTool("plugin__fixture__hidden", "OFFICIAL_PROFILE_BUNDLE_HIDDEN_TOOL_EXECUTED"),
  );
}
