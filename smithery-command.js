module.exports = (config) => ({
  command: "npx",
  args: ["-y", "verity-mcp"],
  env: {
    ...(config.VERITY_PRIVATE_KEY ? { VERITY_PRIVATE_KEY: config.VERITY_PRIVATE_KEY } : {}),
    ...(config.CALLER_ID ? { CALLER_ID: config.CALLER_ID } : {}),
  },
});
