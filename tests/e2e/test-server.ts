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

const CONTAINER_SCROLL_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Container Scroll</title>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        font-family: Arial, sans-serif;
        background: #f3f6fb;
      }
      .app {
        display: grid;
        grid-template-columns: 220px minmax(0, 1fr);
        grid-template-rows: 72px minmax(0, 1fr);
        width: 100vw;
        height: 100vh;
      }
      .topbar {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        padding: 0 24px;
        background: #0f172a;
        color: #fff;
        font-size: 24px;
        font-weight: 700;
      }
      .sidebar {
        padding: 18px;
        background: #dbe7ff;
        border-right: 1px solid #bfd1ff;
      }
      .content-shell {
        min-width: 0;
        min-height: 0;
        padding: 18px;
      }
      #scroll-root {
        height: 100%;
        overflow-y: auto;
        overflow-x: hidden;
        border-radius: 20px;
        background: white;
        border: 1px solid #d7deea;
        box-shadow: 0 16px 50px rgba(15, 23, 42, 0.08);
      }
      .hero {
        position: sticky;
        top: 0;
        padding: 20px 24px;
        background: rgba(255,255,255,0.96);
        border-bottom: 1px solid #edf2f8;
        backdrop-filter: blur(6px);
        z-index: 2;
      }
      .card {
        height: 360px;
        margin: 20px 24px;
        border-radius: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 34px;
        color: #0f172a;
        background: linear-gradient(135deg, #dff3ff, #fff2d8);
      }
    </style>
  </head>
  <body>
    <div class="app">
      <div class="topbar">Internal Scroll Layout</div>
      <aside class="sidebar">
        <p>Navigation</p>
        <p>Projects</p>
        <p>Reports</p>
      </aside>
      <main class="content-shell">
        <div id="scroll-root">
          <div class="hero">Scrollable panel content</div>
          ${Array.from({ length: 9 })
            .map((_, i) => `<section class="card">Panel item ${i + 1}</section>`)
            .join('\n')}
        </div>
      </main>
    </div>
  </body>
</html>`;

function routeHtml(pathname: string): string | null {
  if (pathname === '/long.html') {
    return LONG_PAGE_HTML;
  }
  if (pathname === '/infinite.html') {
    return INFINITE_PAGE_HTML;
  }
  if (pathname === '/container-scroll.html') {
    return CONTAINER_SCROLL_HTML;
  }
  return null;
}

export async function startFixtureServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const html = routeHtml(url.pathname);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (!html) {
      res.statusCode = 404;
      res.end('<!doctype html><html><body><h1>Not found</h1></body></html>');
      return;
    }
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
