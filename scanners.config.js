module.exports = {
  apps: [
    {
      name: "slack-scanners",
      script: "./app.js",
      watch: false,
      autorestart: true, // Automatically restart if the app crashes
      max_restarts: 10,  // Optional: limit the maximum number of restarts
    },
  ],
};
