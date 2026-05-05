// ============================================================
// ComprasAI — Servidor local com proxy do Bling
// ============================================================
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const BLING_BASE = 'https://www.bling.com.br/Api/v3';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function proxyBling(endpoint, token, res) {
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ erro: 'Token não informado.' }));
    return;
  }

  const blingUrl = `${BLING_BASE}/${endpoint}?pagina=1&limite=100`;
  const opts = url.parse(blingUrl);
  opts.headers = {
    'Authorization': `Bearer ${token}`,
    'Accept':        'application/json',
    'Content-Type':  'application/json',
  };

  const req = https.get(opts, (blingRes) => {
    let body = '';
    blingRes.on('data', (chunk) => { body += chunk; });
    blingRes.on('end', () => {
      setCORS(res);
      res.writeHead(blingRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(body);
    });
  });

  req.on('error', (e) => {
    setCORS(res);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ erro: 'Falha ao conectar ao Bling: ' + e.message }));
  });
  req.end();
}

const server = http.createServer((req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Pre-flight CORS
  if (req.method === 'OPTIONS') {
    setCORS(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // API Routes — Proxy Bling
  if (pathname.startsWith('/api/bling/')) {
    const token    = (req.headers['authorization'] || '').replace('Bearer ', '').trim()
                   || parsed.query.token || '';
    const endpoint = pathname.replace('/api/bling/', '');

    const routeMap = {
      'receber':  'contas/receber',
      'pagar':    'contas/pagar',
      'clientes': 'contatos',
      'testar':   'situacoes/modulos',
    };

    const blingEndpoint = routeMap[endpoint];
    if (!blingEndpoint) {
      setCORS(res);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ erro: 'Rota não encontrada: ' + endpoint }));
      return;
    }

    console.log(`[BLING] GET /${blingEndpoint}`);
    proxyBling(blingEndpoint, token, res);
    return;
  }

  // Arquivos estáticos
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Arquivo não encontrado: ' + pathname);
      return;
    }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`ComprasAI rodando na porta ${PORT}`);
});

server.on('error', (e) => {
  console.error('Erro no servidor:', e.message);
  process.exit(1);
});
