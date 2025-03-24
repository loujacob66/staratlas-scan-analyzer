module.exports = {
  apps: [
    {
      name: "efficiency",
      script: "./efficiency.js",
      // Pass arguments "4 pushover" to filter for 4 days and enable pushover notifications
      args: "4 pushover",
      // Restart this process every 3 hours using cron syntax
      cron_restart: "0 */3 * * *",
      // Set additional PM2 options if needed:
      autorestart: true,
      watch: false,
      max_restarts: 5,
      // Environment variables can also be set here, if necessary:
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
