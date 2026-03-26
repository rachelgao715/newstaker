const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ── Load .env file (lightweight, no dependency) ──
try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
            line = line.trim();
            if (!line || line.startsWith('#')) return;
            const idx = line.indexOf('=');
            if (idx > 0) {
                const key = line.slice(0, idx).trim();
                const val = line.slice(idx + 1).trim();
                if (!process.env[key]) process.env[key] = val;
            }
        });
    }
} catch (_) { /* ignore */ }

const PORT = process.env.PORT || 8090;
const LLM_BASE = process.env.LLM_BASE || 'http://localhost:11434';

// ── API Keys are now provided by the user via request header X-API-Key ──
// No hardcoded keys in source code.

// ── newsdata.io key (optional, from env or user) ──
const NEWSDATA_KEY = process.env.NEWSDATA_KEY || '';

// ── Extract user API key from request headers ──
function getUserKey(req) {
    return req.headers['x-api-key'] || '';
}

const MIME = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

// ── Helper: fetch URL (https) and return promise of JSON ──
function fetchJSON(fetchUrl, headers = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(fetchUrl);
        const opts = {
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'NEWSTAKER/1.0',
                ...headers,
            },
        };
        const req = https.request(opts, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(body) });
                } catch (e) {
                    reject(new Error(`JSON parse error: ${body.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
}

// ── Helper: call LLM API (apiKey passed from request) ──
function callLLM(messages, maxTokens = 3000, temperature = 0.3, apiKey = '') {
    return new Promise((resolve, reject) => {
        if (!apiKey) return reject(new Error('No API key provided'));
        const llmUrl = new URL('/v1/chat/completions', LLM_BASE);
        const bodyStr = JSON.stringify({
            model: 'gpt-4o',
            messages,
            temperature,
            max_tokens: maxTokens,
        });
        const options = {
            hostname: llmUrl.hostname,
            port: llmUrl.port || 443,
            path: llmUrl.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(bodyStr),
            },
        };
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (res.statusCode === 401 || res.statusCode === 403) {
                        return reject(new Error('AUTH_FAILED'));
                    }
                    if (res.statusCode !== 200) {
                        return reject(new Error(parsed.error?.message || `LLM returned ${res.statusCode}`));
                    }
                    resolve(parsed);
                }
                catch (e) { reject(new Error('LLM JSON parse error')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('LLM timeout')); });
        req.write(bodyStr);
        req.end();
    });
}

// ── Parse LLM JSON response (handles markdown wrapping) ──
function parseLLMContent(content) {
    try { return JSON.parse(content); } catch {}
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) return JSON.parse(jsonMatch[1].trim());
    const objMatch = content.match(/\{[\s\S]*\}/);
    if (objMatch) return JSON.parse(objMatch[0]);
    throw new Error('Could not parse LLM response');
}

// ── LLM-generated news (default demo mode) ──
async function getLLMNews(type, options = {}) {
    const { query, lang, lat, lng, location, apiKey } = options;
    const today = new Date().toISOString().split('T')[0];

    let systemPrompt, userMessage;

    const baseRules = `RULES:
1. Return ONLY valid JSON — no markdown, no explanation, no backticks.
2. Each item MUST have accurate lat/lng for the event location.
3. Category: conflict, politics, economy, tech, health, env, society
4. Sentiment: POSITIVE, NEUTRAL, NEGATIVE
5. Intensity: 0.2-1.0
6. time: relative time like "2H AGO", "1D AGO"
7. For the "url" field: generate a realistic-looking article URL from the source domain (e.g. "https://reuters.com/world/..." or "https://bbc.com/news/..."). It does NOT need to be real — this is for demo/display purposes.

JSON format:
{
  "results": [
    {
      "title": "Headline",
      "summary": "2-3 sentence summary",
      "category": "economy",
      "location": "City, Country",
      "lat": 40.7128,
      "lng": -74.0060,
      "source": "Reuters",
      "time": "2H AGO",
      "sentiment": "NEUTRAL",
      "intensity": 0.7,
      "url": "https://reuters.com/world/example-article-2026"
    }
  ]
}`;

    if (type === 'trending') {
        systemPrompt = `You are a news assistant for NEWSTAKER. Today is ${today}.
Provide current global trending news events. Cover diverse categories and regions. Return 8-12 items.
${baseRules}`;
        userMessage = lang === 'zh'
            ? '请提供当前全球最重要的新闻事件，覆盖不同类别和地区。返回 JSON。'
            : 'Provide the most important global news events right now. Return structured JSON.';

    } else if (type === 'search') {
        systemPrompt = `You are a news search assistant for NEWSTAKER. Today is ${today}.
Search for news events related to the user's query. Return 5-12 items.
${baseRules}`;
        userMessage = `Search for news about: "${query}". Return JSON.`;

    } else if (type === 'nearby') {
        systemPrompt = `You are a regional news assistant for NEWSTAKER. Today is ${today}.
Find news events near ${location || `lat ${lat}, lng ${lng}`}. Return 5-10 items near the location.
${baseRules}`;
        userMessage = `Find news events near ${location || `coordinates ${lat},${lng}`}. Return JSON.`;
    }

    const data = await callLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
    ], 4000, 0.3, apiKey);

    const content = data.choices?.[0]?.message?.content || '';
    return parseLLMContent(content).results || [];
}

// ── newsdata.io real news + LLM enrichment (activated by triple-click) ──
async function getNewsdataNews(type, options = {}) {
    const { query, lang, lat, lng, location, apiKey, newsdataKey } = options;
    const langCode = lang === 'zh' ? 'zh' : 'en';
    const ndKey = newsdataKey || NEWSDATA_KEY;
    if (!ndKey) throw new Error('No newsdata.io API key configured');

    let apiUrl;
    if (type === 'trending') {
        apiUrl = `https://newsdata.io/api/1/latest?apikey=${ndKey}&language=${langCode}`;
    } else if (type === 'search') {
        apiUrl = `https://newsdata.io/api/1/latest?apikey=${ndKey}&q=${encodeURIComponent(query)}&language=${langCode}`;
    } else if (type === 'nearby') {
        const q = location || `${lat},${lng}`;
        apiUrl = `https://newsdata.io/api/1/latest?apikey=${ndKey}&q=${encodeURIComponent(q)}&language=${langCode}`;
    }

    console.log(`[newsdata.io] Fetching: ${type}`);
    const { status, data } = await fetchJSON(apiUrl);

    if (status !== 200 || !data.results || data.results.length === 0) {
        throw new Error(`newsdata.io returned ${status}: ${data.message || 'no results'}`);
    }

    // Convert newsdata.io format to our format via LLM enrichment
    const articles = data.results.filter(a => a.title).slice(0, 15);
    const compact = articles.map((a, i) => ({
        i,
        title: (a.title || '').slice(0, 150),
        description: (a.description || '').slice(0, 300),
        url: a.link || '',
        source: a.source_name || a.source_id || '',
        pubDate: a.pubDate || '',
        country: (a.country || []).join(', '),
        category: (a.category || []).join(', '),
    }));

    const enrichPrompt = `You are a data enrichment assistant for NEWSTAKER.

Given real news articles, add geographic coordinates, category, sentiment, and a clean summary.

RULES:
1. Return ONLY valid JSON — no markdown.
2. Determine the PRIMARY location and provide accurate lat/lng.
3. Category: conflict, politics, economy, tech, health, env, society
4. Sentiment: POSITIVE, NEUTRAL, NEGATIVE. Intensity: 0.2-1.0
5. location: "City, Country" format.
6. time: convert pubDate to relative time like "2H AGO", "1D AGO". Current: ${new Date().toISOString()}
7. summary: clean 1-2 sentence summary.
8. PRESERVE the original url exactly — do NOT modify it.

Return: { "results": [ { "i": 0, "title": "...", "summary": "...", "category": "...", "location": "...", "lat": 0, "lng": 0, "source": "...", "time": "...", "sentiment": "...", "intensity": 0.0, "url": "original url" } ] }`;

    const llmData = await callLLM([
        { role: 'system', content: enrichPrompt },
        { role: 'user', content: `Enrich these ${compact.length} articles:\n${JSON.stringify(compact, null, 1)}` },
    ], 4000, 0.3, apiKey);

    const llmContent = llmData.choices?.[0]?.message?.content || '';
    const parsed = parseLLMContent(llmContent);
    const results = parsed.results || [];

    // Ensure real URLs are preserved
    return results.map(r => {
        if (r.i != null && articles[r.i]) {
            r.url = articles[r.i].link || r.url || '';
        }
        return r;
    });
}

// ================================================================
// HTTP SERVER
// ================================================================
const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);

    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
    }

    // ================================================================
    // /api/verify — Verify user's API key against the LLM endpoint
    // ================================================================
    if (parsed.pathname === '/api/verify' && req.method === 'POST') {
        const apiKey = getUserKey(req);
        if (!apiKey) {
            res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ ok: false, error: 'NO_KEY', message: 'Please provide an API key in the X-API-Key header.' }));
            return;
        }
        try {
            await callLLM([
                { role: 'user', content: 'Say "ok"' }
            ], 10, 0, apiKey);
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ ok: true, message: 'API key verified successfully.' }));
        } catch (err) {
            const isAuth = err.message === 'AUTH_FAILED';
            res.writeHead(isAuth ? 401 : 500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({
                ok: false,
                error: isAuth ? 'AUTH_FAILED' : 'VERIFY_ERROR',
                message: isAuth
                    ? 'API key is invalid or unauthorized. Please check your key and the endpoint it connects to.'
                    : `Verification failed: ${err.message}`
            }));
        }
        return;
    }

    // ================================================================
    // /api/news/trending
    // ?lang=en&source=llm|real
    // ================================================================
    if (parsed.pathname === '/api/news/trending' && req.method === 'GET') {
        const apiKey = getUserKey(req);
        if (!apiKey) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ error: 'API key required', results: [] }));
            return;
        }
        try {
            const lang = parsed.query.lang || 'en';
            const source = parsed.query.source || 'llm';
            let results;

            if (source === 'real') {
                try {
                    results = await getNewsdataNews('trending', { lang, apiKey });
                    console.log(`[Trending] newsdata.io returned ${results.length} results`);
                } catch (err) {
                    console.error('[Trending] newsdata.io failed:', err.message, '→ fallback to LLM');
                    results = await getLLMNews('trending', { lang, apiKey });
                }
            } else {
                results = await getLLMNews('trending', { lang, apiKey });
            }

            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ results, source }));
        } catch (err) {
            console.error('Trending error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ error: err.message, results: [] }));
        }
        return;
    }

    // ================================================================
    // /api/news/search
    // ?q=...&lang=en&source=llm|real
    // ================================================================
    if (parsed.pathname === '/api/news/search' && req.method === 'GET') {
        const apiKey = getUserKey(req);
        if (!apiKey) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ error: 'API key required', results: [] }));
            return;
        }
        try {
            const q = parsed.query.q || '';
            const lang = parsed.query.lang || 'en';
            const source = parsed.query.source || 'llm';
            if (!q) throw new Error('Missing query parameter "q"');

            let results;

            if (source === 'real') {
                try {
                    results = await getNewsdataNews('search', { query: q, lang, apiKey });
                } catch (err) {
                    console.error('[Search] newsdata.io failed:', err.message, '→ fallback to LLM');
                    results = await getLLMNews('search', { query: q, lang, apiKey });
                }
            } else {
                results = await getLLMNews('search', { query: q, lang, apiKey });
            }

            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ results, source }));
        } catch (err) {
            console.error('Search error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ error: err.message, results: [] }));
        }
        return;
    }

    // ================================================================
    // /api/news/nearby
    // ?lat=...&lng=...&location=...&lang=en&source=llm|real
    // ================================================================
    if (parsed.pathname === '/api/news/nearby' && req.method === 'GET') {
        const apiKey = getUserKey(req);
        if (!apiKey) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ error: 'API key required', results: [] }));
            return;
        }
        try {
            const lat = parseFloat(parsed.query.lat) || 0;
            const lng = parseFloat(parsed.query.lng) || 0;
            const locName = parsed.query.location || `${lat},${lng}`;
            const lang = parsed.query.lang || 'en';
            const source = parsed.query.source || 'llm';

            let results;

            if (source === 'real') {
                try {
                    results = await getNewsdataNews('nearby', { lat, lng, location: locName, lang, apiKey });
                } catch (err) {
                    console.error('[Nearby] newsdata.io failed:', err.message, '→ fallback to LLM');
                    results = await getLLMNews('nearby', { lat, lng, location: locName, lang, apiKey });
                }
            } else {
                results = await getLLMNews('nearby', { lat, lng, location: locName, lang, apiKey });
            }

            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ results, source }));
        } catch (err) {
            console.error('Nearby error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ error: err.message, results: [] }));
        }
        return;
    }

    // ---- Proxy: /api/llm -> LLM (uses user's API key) ----
    if (parsed.pathname === '/api/llm' && req.method === 'POST') {
        const apiKey = getUserKey(req);
        if (!apiKey) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ error: 'API key required' }));
            return;
        }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const llmUrl = new URL('/v1/chat/completions', LLM_BASE);
            const options = {
                hostname: llmUrl.hostname,
                port: llmUrl.port || 443,
                path: llmUrl.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const proxy = https.request(options, (proxyRes) => {
                res.writeHead(proxyRes.statusCode, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                proxyRes.pipe(res);
            });

            proxy.on('error', (err) => {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            });

            proxy.write(body);
            proxy.end();
        });
        return;
    }

    // ---- Static file server ----
    let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
    filePath = path.join(__dirname, filePath);

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`NEWSTAKER server running at http://localhost:${PORT}`);
    console.log(`  Default:  LLM-generated news (demo mode)`);
    console.log(`  Real API: newsdata.io (triple-click OK to activate)`);
    console.log(`  Routes:   /api/news/trending, /api/news/search?q=, /api/news/nearby?lat=&lng=`);
    console.log(`  LLM:      /api/llm`);
});
