// ============================================================
// ComprasAI — Servidor local com proxy do Bling (OAuth2)
// ============================================================
const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const url       = require('url');
const querystring = require('querystring');
const crypto    = require('crypto');

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

// Estados OAuth2 pendentes: Map<state, expiresAt> — proteção CSRF
const pendingOAuthStates = new Map();
const OAUTH_STATE_TTL_MS             = 10 * 60 * 1000; // 10 minutos
const OAUTH_STATE_CLEANUP_INTERVAL_MS =  5 * 60 * 1000; //  5 minutos

// Limpa estados expirados periodicamente para evitar crescimento ilimitado da Map
setInterval(() => {
  const now = Date.now();
  for (const [state, expiry] of pendingOAuthStates) {
    if (now > expiry) pendingOAuthStates.delete(state);
  }
}, OAUTH_STATE_CLEANUP_INTERVAL_MS).unref();

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

// Parâmetros extras por endpoint.
// criterio=3 → retorna todos os produtos independente de estoque.
// situacao=A → somente produtos ativos (evita ter que filtrar inativos no cliente).
const ENDPOINT_EXTRA_PARAMS = {
  'produtos': '&criterio=3&situacao=A',
};

function fetchBlingPage(endpoint, token, pagina, callback) {
  const extra = ENDPOINT_EXTRA_PARAMS[endpoint] || '';
  const blingUrl = `${BLING_BASE}/${endpoint}?pagina=${pagina}&limite=100${extra}`;
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
        callback(null, blingRes.statusCode, JSON.parse(body), blingRes.headers);
      } catch (e) {
        callback(e);
      }
    });
  });

  req.on('error', callback);
  req.end();
}

const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 2000;

// Faz a requisição e tenta novamente em caso de erro 429 (Too Many Requests)
function fetchBlingPageWithRetry(endpoint, token, pagina, retriesLeft, callback) {
  fetchBlingPage(endpoint, token, pagina, (err, statusCode, json, headers) => {
    if (err) return callback(err);
    if (statusCode === 429 && retriesLeft > 0) {
      const retryAfterHeader = headers && headers['retry-after'];
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
      const waitMs = !isNaN(retryAfterSec)
        ? Math.min(retryAfterSec * 1000, 30000)
        : DEFAULT_RETRY_DELAY_MS;
      console.log(`[BLING] Rate limited (429) on /${endpoint} página ${pagina}, aguardando ${waitMs}ms (${retriesLeft} tentativa(s) restante(s))...`);
      setTimeout(() => fetchBlingPageWithRetry(endpoint, token, pagina, retriesLeft - 1, callback), waitMs);
      return;
    }
    callback(null, statusCode, json);
  });
}

function proxyBling(endpoint, token, res) {
  const allItems = [];

  function fetchPage(pagina) {
    fetchBlingPageWithRetry(endpoint, token, pagina, MAX_RETRIES, (err, statusCode, json) => {
      if (err) {
        setCORS(res);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ erro: 'Falha ao conectar ao Bling: ' + err.message }));
        return;
      }

      if (statusCode !== 200 || !Array.isArray(json.data)) {
        if (allItems.length > 0) {
          // Já coletamos itens de páginas anteriores — a página extra provavelmente
          // está fora do intervalo (end-of-data). Retorna o que foi coletado.
          setCORS(res);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: allItems }));
        } else {
          // Nenhum item coletado ainda — repassa a resposta de erro do Bling.
          setCORS(res);
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(json));
        }
        return;
      }

      allItems.push(...json.data);

      // Se a página retornou 100 itens, pode haver mais páginas
      if (json.data.length === 100) {
        // Pequena pausa entre páginas para evitar disparar o limite de requisições do Bling
        setTimeout(() => fetchPage(pagina + 1), 300);
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
    const oauthState = crypto.randomBytes(16).toString('hex');
    pendingOAuthStates.set(oauthState, Date.now() + OAUTH_STATE_TTL_MS);
    const authUrl = `${BLING_AUTH_URL}?response_type=code&client_id=${encodeURIComponent(blingConfig.clientId)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent('read:todos')}&state=${oauthState}`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // ---- OAuth2: callback do Bling ----
  if (pathname === '/callback') {
    const code       = parsed.query.code;
    const error      = parsed.query.error;
    const stateParam = parsed.query.state;

    if (error || !code) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>❌ Autenticação cancelada</h2><p>${error || 'Código não recebido.'}</p><a href="/">← Voltar ao sistema</a></body></html>`);
      return;
    }

    const stateExpiry = stateParam ? pendingOAuthStates.get(stateParam) : undefined;
    if (!stateExpiry || Date.now() > stateExpiry) {
      // State expirado ou desconhecido — limpa e rejeita.
      // Map.delete em chave inexistente é no-op, por isso é seguro chamá-lo incondicionalmente.
      pendingOAuthStates.delete(stateParam);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>❌ Erro de segurança</h2><p>Parâmetro state inválido ou expirado. Tente conectar novamente.</p><a href="/">← Voltar ao sistema</a></body></html>`);
      return;
    }
    // Remove somente após validação bem-sucedida (one-time use)
    pendingOAuthStates.delete(stateParam);

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
