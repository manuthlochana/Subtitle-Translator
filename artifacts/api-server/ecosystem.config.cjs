module.exports = {
  apps: [
    {
      name: "subtitle-api",
      cwd: __dirname,
      script: "./dist/index.mjs",
      node_args: "--enable-source-maps --env-file=.env",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "300M",
      env: { NODE_ENV: "production" },
    },
  ],
};
