#!/usr/bin/env node
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import API handlers
import search from './api/search.js';
import searchPaiute from './api/search-paiute.js';
import searchSentences from './api/search-sentences.js';

// Simple router
const routes = {
  '/api/search': search,
  '/api/search-paiute': searchPaiute,
  '/api/search-sentences': searchSentences,
};

// Create a simple mock for Vercel's req/res
function createMockRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return {
    method: req.method,
    url: req.url,
    headers: req.headers,
    query: Object.fromEntries(url.searchParams),
  };
}

function createMockResponse(res) {
  return {
    status: (code) => {
      res.statusCode = code;
      return mockRes;
    },
    json: (data) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(JSON.stringify(data));
    },
    send: (data) => {
      res.end(data);
    },
  };
}

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Handle word by ID (dynamic route)
  if (url.pathname.match(/^\/api\/word\/.+$/)) {
    const id = url.pathname.split('/').pop();
    try {
      const handler = await import('./api/word/[id].js');
      const mockReq = createMockRequest(req);
      mockReq.query.id = id;
      const mockRes = createMockResponse(res);
      await handler.default(mockReq, mockRes);
      return;
    } catch (error) {
      console.error('Error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
  }

  // Handle static routes
  const handler = routes[url.pathname];

  if (handler) {
    try {
      const mockReq = createMockRequest(req);
      const mockRes = createMockResponse(res);
      await handler(mockReq, mockRes);
    } catch (error) {
      console.error('Error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Dev server running at http://localhost:${PORT}`);
  console.log('');
  console.log('Available endpoints:');
  console.log(`  GET http://localhost:${PORT}/api/search?q=dog`);
  console.log(`  GET http://localhost:${PORT}/api/search-paiute?q=tüka`);
  console.log(`  GET http://localhost:${PORT}/api/search-sentences?q=hungry`);
  console.log(`  GET http://localhost:${PORT}/api/word/:id`);
  console.log('');
  console.log('Press Ctrl+C to stop');
});
