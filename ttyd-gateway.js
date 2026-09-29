const http = require('http');
const net = require('net');

const SECRET = 'ce4b3fd9862c013c430bd12e9a0769e2';
const UP_HOST = '127.0.0.1';
const LISTEN_PORT = 7681;

const UPSTREAMS = {
  '/': { port: 7686, label: 'main' },
};

function authorized(req) {
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('key') === SECRET) return true;
  const cookies = req.headers.cookie || '';
  return cookies.split(/;\s*/).some(c => c === 'key=' + SECRET);
}

function rewritePath(pathname, prefix) {
  if (prefix === '/') return pathname;
  return pathname.replace(prefix, '') || '/';
}

function getUpstream(pathname) {
  for (const [prefix, cfg] of Object.entries(UPSTREAMS)) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return { ...cfg, prefix };
  }
  return { ...UPSTREAMS['/'], prefix: '/' };
}

function proxyReq(req, res, upHost, upPort) {
  if (!authorized(req)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('401 Unauthorized: URL must include ?key=<SECRET>');
    return;
  }
  res.setHeader('Set-Cookie', `key=${SECRET}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
  const parsed = new URL(req.url, 'http://localhost');
  const upstreamPath = rewritePath(parsed.pathname, getUpstream(parsed.pathname).prefix) + parsed.search;
  const headers = Object.assign({}, req.headers, { host: `${upHost}:${upPort}` });
  const proxy = http.request(
    { host: upHost, port: upPort, path: upstreamPath, method: req.method, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    }
  );
  proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Bad Gateway'); });
  req.pipe(proxy);
}

const server = http.createServer((req, res) => {
  const { port } = getUpstream(new URL(req.url, 'http://localhost').pathname);
  proxyReq(req, res, UP_HOST, port);
});

server.on('upgrade', (req, socket, head) => {
  const { port, prefix } = getUpstream(new URL(req.url, 'http://localhost').pathname);
  if (!authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const parsed = new URL(req.url, 'http://localhost');
  const upstreamPath = rewritePath(parsed.pathname, prefix) + parsed.search;
  const up = net.connect(port, UP_HOST, () => {
    const lines = [`${req.method} ${upstreamPath} HTTP/1.1`, `Host: ${UP_HOST}:${port}`, 'Connection: Upgrade'];
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host', 'connection', 'upgrade'].includes(k.toLowerCase())) continue;
      lines.push(`${k}: ${v}`);
    }
    lines.push('Upgrade: websocket');
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`ttyd-gateway listening on :${LISTEN_PORT}`);
  console.log('  /       -> 127.0.0.1:7686 (main)');
});
