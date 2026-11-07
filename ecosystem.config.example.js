// Copy this file to ecosystem.config.js and fill in your own paths.
// ecosystem.config.js is git-ignored because it holds machine-specific paths.
module.exports = {
  apps: [{
    name: 'musicsync',
    script: 'server.js',
    env: {
      PORT: 3000,

      // Full path to yt-dlp if it's not on your PATH (use double backslashes on Windows)
      // Example: 'C:\\Users\\you\\AppData\\...\\Python313\\Scripts\\yt-dlp.exe'
      YTDLP: 'yt-dlp',

      // Exported cookies.txt (see README). Needed for YouTube's bot check.
      COOKIES_FILE: '',

      // Leave empty on Windows + Brave/Chrome: reading browser cookies usually fails
      COOKIES_BROWSER: '',

      // JS runtime yt-dlp uses to solve YouTube's "n challenge"
      YTDLP_JS_RUNTIME: 'node',

      // Set to '1' if yt-dlp still complains about the challenge solver
      YTDLP_REMOTE_COMPONENTS: ''
    }
  }]
};