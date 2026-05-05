// ============================================================
// ComprasAI — Servidor local com proxy do Bling (OAuth2)
// ============================================================
const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const url       = require('url');
const querystring = require('querystring');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const BLING_BASE       = 'https://api.bling.com.br/Api/v3';
const BLING_AUTH_URL   = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const BLING_TOKEN_URL  = 'https://www.bling.com.br/Api/v3/oauth/token';

// Suporta URL pública via variável de ambiente (Render define RENDER_EXTERNAL_URL
// automaticamente; também pode ser definida manualmente como APP_URL).
const APP_BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;
const REDIRECT_URI = `${APP_BASE_URL}/callback`;

// ---- Carregar credenciais OAuth2 do arquivo de configuração ou variáveis de ambiente ----
let blingConfig = { clientId: '', clientSecret: '' };
try {
  blingConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'bling.config.json'), 'utf8'));
} catch (e) {
  // Fallback para variáveis de ambiente (necessário em produção/Render)
  if (process.env.BLING_CLIENT_ID && process.env.BLING_CLIENT_SECRET) {
    blingConfig = { clientId: process.env.BLING_CLIENT_ID, clientSecret: process.env.BLING_CLIENT_SECRET };
    console.log('[CONFIG] Credenciais Bling carregadas via variáveis de ambiente.');
  } else {
    console.warn('[CONFIG] bling.config.json não encontrado e variáveis BLING_CLIENT_ID/BLING_CLIENT_SECRET não definidas.');
  }
}

// ---- Carregar token OAuth2 salvo localmente ----
let storedToken = { access_token: '', refresh_token: '', expires_at: 0 };
try {
  storedToken = JSON.parse(fs.readFileSync(path.join(__dirname, 'bling.token.json'), 'utf8'));
} catch (e) { /* token ainda não existe */ }

function saveToken(data) {
  storedToken = data;
  fs.writeFileSync(path.join(__dirname, 'bling.token.json'), JSON.stringify(data), 'utf8');
}

function isTokenValid() {
  return storedToken.access_token && Date.now() < storedToken.expires_at - 60000;
}

// ---- Trocar código de autorização ou refresh token ----
function exchangeToken(params, callback) {
  const body = querystring.stringify(params);
  const credentials = Buffer.from(`${blingConfig.clientId}:${blingConfig.clientSecret}`).toString('base64');

  const opts = {
    hostname: 'www.bling.com.br',
    path:     '/Api/v3/oauth/token',
    method:   'POST',
    headers:  {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': `Basic ${credentials}`,
      'Accept':        'application/json',
    },
  };

  const req = https.request(opts, (r) => {
    let data = '';
    r.on('data', (c) => { data += c; });
    r.on('end', () => {
      try { callback(null, JSON.parse(data)); }
      catch (e) { callback(e); }
    });
  });
  req.on('error', callback);
  req.write(body);
  req.end();
}

// ---- Renovar access token usando refresh token ----
function refreshAccessToken(callback) {
  if (!storedToken.refresh_token) return callback(new Error('Sem refresh token'));
  exchangeToken({
    grant_type:    'refresh_token',
    refresh_token: storedToken.refresh_token,
  }, (err, data) => {
    if (err || data.error) return callback(err || new Error(data.error_description || data.error));
    saveToken({
      access_token:  data.access_token,
      refresh_token: data.refresh_token || storedToken.refresh_token,
      expires_at:    Date.now() + (data.expires_in || 3600) * 1000,
    });
    callback(null);
  });
}

// ---- Obter token válido (renova se necessário) ----
function getValidToken(callback) {
  if (isTokenValid()) return callback(null, storedToken.access_token);
  if (storedToken.refresh_token) {
    refreshAccessToken((err) => {
      if (err) return callback(err);
      callback(null, storedToken.access_token);
    });
  } else {
    callback(new Error('Não autenticado'));
  }
}

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

function fetchBlingPage(endpoint, token, pagina, callback) {
  const blingUrl = `${BLING_BASE}/${endpoint}?pagina=${pagina}&limite=100`;
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
      try {
        callback(null, blingRes.statusCode, JSON.parse(body));
      } catch (e) {
        callback(e);
      }
    });
  });

  req.on('error', callback);
  req.end();
}

function proxyBling(endpoint, token, res) {
  const allItems = [];

  function fetchPage(pagina) {
    fetchBlingPage(endpoint, token, pagina, (err, statusCode, json) => {
      if (err) {
        setCORS(res);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ erro: 'Falha ao conectar ao Bling: ' + err.message }));
        return;
      }

      if (statusCode !== 200 || !json.data) {
        // Retorna a resposta original do Bling em caso de erro ou formato inesperado
        setCORS(res);
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
        return;
      }

      allItems.push(...json.data);

      // Se a página retornou 100 itens, pode haver mais páginas
      if (json.data.length === 100) {
        fetchPage(pagina + 1);
      } else {
        // Todas as páginas foram buscadas — retorna resultado combinado
        setCORS(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: allItems }));
      }
    });
  }

  fetchPage(1);
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

  // ---- OAuth2: iniciar login ----
  if (pathname === '/api/auth/login') {
    if (!blingConfig.clientId) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Erro: bling.config.json não configurado. Veja LEIAME.txt.');
      return;
    }
    const authUrl = `${BLING_AUTH_URL}?response_type=code&client_id=${encodeURIComponent(blingConfig.clientId)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=comprasai`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // ---- OAuth2: callback do Bling ----
  if (pathname === '/callback') {
    const code  = parsed.query.code;
    const error = parsed.query.error;

    if (error || !code) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>❌ Autenticação cancelada</h2><p>${error || 'Código não recebido.'}</p><a href="/">← Voltar ao sistema</a></body></html>`);
      return;
    }

    exchangeToken({
      grant_type:   'authorization_code',
      code:         code,
      redirect_uri: REDIRECT_URI,
    }, (err, data) => {
      if (err || data.error) {
        const msg = (err ? err.message : null) || data.error_description || data.error || 'Erro desconhecido';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>❌ Erro ao autenticar</h2><p>${msg}</p><a href="/">← Voltar</a></body></html>`);
        return;
      }

      saveToken({
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        expires_at:    Date.now() + (data.expires_in || 3600) * 1000,
      });

      console.log('[AUTH] Token Bling salvo com sucesso.');
      res.writeHead(302, { Location: '/?bling=ok' });
      res.end();
    });
    return;
  }

  // ---- OAuth2: status de autenticação ----
  if (pathname === '/api/auth/status') {
    setCORS(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      autenticado:   !!(storedToken.access_token),
      tokenValido:   isTokenValid(),
      temRefresh:    !!(storedToken.refresh_token),
      configOk:      !!(blingConfig.clientId && blingConfig.clientSecret),
    }));
    return;
  }

  // ---- OAuth2: logout ----
  if (pathname === '/api/auth/logout') {
    storedToken = { access_token: '', refresh_token: '', expires_at: 0 };
    try { fs.unlinkSync(path.join(__dirname, 'bling.token.json')); } catch (e) { /* ok */ }
    setCORS(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ---- API Routes — Proxy Bling (usa token OAuth2 automaticamente) ----
  if (pathname.startsWith('/api/bling/')) {
    const endpoint = pathname.replace('/api/bling/', '');

    const routeMap = {
      'receber':  'contas/receber',
      'pagar':    'contas/pagar',
      'clientes': 'contatos',
      'produtos': 'produtos',
      'estoques': 'estoques/saldos',
      'testar':   'situacoes/modulos',
    };

    const blingEndpoint = routeMap[endpoint];
    if (!blingEndpoint) {
      setCORS(res);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ erro: 'Rota não encontrada: ' + endpoint }));
      return;
    }

    getValidToken((err, token) => {
      if (err) {
        setCORS(res);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ erro: 'Não autenticado. Conecte-se ao Bling primeiro.', naoAutenticado: true }));
        return;
      }
      console.log(`[BLING] GET /${blingEndpoint}`);
      proxyBling(blingEndpoint, token, res);
    });
    return;
  }

  // ---- Arquivos estáticos ----
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
  if (!blingConfig.clientId) {
    console.warn('  ⚠ bling.config.json não encontrado. Crie o arquivo para habilitar integração Bling.');
  }
});

server.on('error', (e) => {
  console.error('Erro no servidor:', e.message);
  process.exit(1);
});
