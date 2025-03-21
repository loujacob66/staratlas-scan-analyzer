module.exports = {
  apps: [
    {
      name: "scanners-pushover-job",
      script: "app_local_pushover.js",
      args: "pushover 4",
      // Restart the process at minute 0 every 3 hours (e.g., 00:00, 03:00, 06:00, etc.)
      cron_restart: "0 */3 * * *",
      // Do not auto-restart if the process exits normally; only restart via cron
      autorestart: false,
      exec_mode: "fork",
      // Optionally, log output to files:
      error_file: "./logs/pushover-job-error.log",
      out_file: "./logs/pushover-job-out.log",
      merge_logs: true
    }
  ]
};

