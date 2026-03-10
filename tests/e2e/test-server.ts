import { createServer, type Server } from 'node:http';

const LONG_PAGE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Long Page</title>
    <style>
      body { margin: 0; font-family: Arial, sans-serif; }
      section {
        height: 500px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 40px;
      }
      section:nth-child(odd) { background: #f7f7f7; }
      section:nth-child(even) { background: #e7f2ff; }
    </style>
  </head>
  <body>
    ${Array.from({ length: 14 })
      .map((_, i) => `<section>Section ${i + 1}</section>`)
      .join('\n')}
  </body>
</html>`;

const INFINITE_PAGE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Infinite Page</title>
    <style>
      body { margin: 0; font-family: Arial, sans-serif; }
      .sticky {
        position: sticky;
        top: 0;
        background: #111;
        color: #fff;
        padding: 10px;
        z-index: 5;
      }
      .item {
        height: 420px;
        margin: 8px;
        border-radius: 8px;
        background: linear-gradient(135deg, #e8f0ff, #fff5e6);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 30px;
      }
    </style>
  </head>
  <body>
    <div class="sticky">Sticky Header (should not duplicate)</div>
    <div id="feed"></div>
    <script>
      let batch = 0;
      const maxBatch = 6;
      const feed = document.getElementById('feed');
      function addBatch() {
        if (batch >= maxBatch) return;
        batch += 1;
        for (let i = 0; i < 4; i++) {
          const div = document.createElement('div');
          div.className = 'item';
          div.textContent = 'Batch ' + batch + ' / Item ' + (i + 1);
          feed.appendChild(div);
        }
      }
      addBatch();
      window.addEventListener('scroll', () => {
        if ((window.innerHeight + window.scrollY) >= document.body.scrollHeight - 120) {
          setTimeout(addBatch, 120);
        }
      });
    </script>
  </body>
</html>`;

function routeHtml(pathname: string): string {
  if (pathname === '/long.html') {
    return LONG_PAGE_HTML;
  }
  if (pathname === '/infinite.html') {
    return INFINITE_PAGE_HTML;
  }
  return '<!doctype html><html><body><h1>Not found</h1></body></html>';
}

export async function startFixtureServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const html = routeHtml(url.pathname);
    if (url.pathname !== '/long.html' && url.pathname !== '/infinite.html') {
      res.statusCode = 404;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not determine fixture server address.');
  }

  return {
    server,
    origin: `http://127.0.0.1:${address.port}`
  };
}
