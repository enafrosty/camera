const express = require('express');
const cors = require('cors');

const PUBLIC_PATHS = new Set(['/', '/index.html', '/style.css', '/app.js']);

function createApp() {
  const app = express();
  app.use(cors());

  app.use((req, res, next) => {
    const reqPath = req.path;
    if (
      reqPath.includes('/.') ||
      reqPath === '/tests' ||
      reqPath.startsWith('/tests/') ||
      reqPath === '/node_modules' ||
      reqPath.startsWith('/node_modules/') ||
      reqPath === '/server.js' ||
      reqPath === '/package.json' ||
      reqPath === '/package-lock.json' ||
      !PUBLIC_PATHS.has(reqPath)
    ) {
      return res.status(404).type('text/plain').send('Not Found');
    }
    return next();
  });

  app.use(express.static(__dirname, { dotfiles: 'ignore', index: 'index.html' }));

  app.use((req, res) => {
    res.status(404).type('text/plain').send('Not Found');
  });

  return app;
}

const app = createApp();

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`CAMERA / WITH EFFECTS server running at http://localhost:${port}`);
  });
}

module.exports = { app, createApp };
