import {
  searchEnglish,
  searchPaiute,
  searchSentences,
  getWordById,
  getWordOfTheDay,
  getRandomWord,
  getRandomSentence,
  browseWords,
  getLetterCounts,
  getAudio
} from './db.js';

// Simple router
function Router() {
  const routes = [];

  return {
    get(path, handler) {
      routes.push({ method: 'GET', path, handler });
    },
    async handle(request, env) {
      const url = new URL(request.url);
      const method = request.method;

      // Handle CORS preflight
      if (method === 'OPTIONS') {
        return new Response(null, {
          headers: corsHeaders()
        });
      }

      for (const route of routes) {
        if (route.method !== method) continue;

        const match = matchPath(route.path, url.pathname);
        if (match) {
          try {
            const response = await route.handler(request, env, match.params, url.searchParams);
            return addCorsHeaders(response);
          } catch (error) {
            console.error('Handler error:', error);
            return addCorsHeaders(json({ error: 'Internal server error' }, 500));
          }
        }
      }

      return addCorsHeaders(json({ error: 'Not found' }, 404));
    }
  };
}

function matchPath(pattern, pathname) {
  // Handle dynamic segments like /word/:id
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }

  return { params };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function addCorsHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    headers
  });
}

// Create router and define routes
const router = Router();

// Search English (vector search)
router.get('/search', async (request, env, params, searchParams) => {
  const q = searchParams.get('q');
  const limit = parseInt(searchParams.get('limit') || '10');
  const skip = parseInt(searchParams.get('skip') || '0');

  if (!q) {
    return json({ error: 'Query parameter "q" is required' }, 400);
  }

  const results = await searchEnglish(q, limit, skip, env);
  return json({ results, pagination: { limit, skip } });
});

// Search Paiute (text search)
router.get('/search-paiute', async (request, env, params, searchParams) => {
  const q = searchParams.get('q');
  const limit = parseInt(searchParams.get('limit') || '10');
  const skip = parseInt(searchParams.get('skip') || '0');

  if (!q) {
    return json({ error: 'Query parameter "q" is required' }, 400);
  }

  const results = await searchPaiute(q, limit, skip, env);
  return json({ results, pagination: { limit, skip } });
});

// Search sentences (vector search)
router.get('/search-sentences', async (request, env, params, searchParams) => {
  const q = searchParams.get('q');
  const limit = parseInt(searchParams.get('limit') || '10');
  const skip = parseInt(searchParams.get('skip') || '0');

  if (!q) {
    return json({ error: 'Query parameter "q" is required' }, 400);
  }

  const results = await searchSentences(q, limit, skip, env);
  return json({ results, pagination: { limit, skip } });
});

// Get word by ID
router.get('/word/:id', async (request, env, params) => {
  const { id } = params;

  const word = await getWordById(id, env);
  if (!word) {
    return json({ error: 'Word not found' }, 404);
  }

  const audio = await getAudio(word.word || word.lexeme_form, env);
  return json({ word, audio });
});

// Browse words
router.get('/browse', async (request, env, params, searchParams) => {
  const letter = searchParams.get('letter');
  const limit = parseInt(searchParams.get('limit') || '50');
  const skip = parseInt(searchParams.get('skip') || '0');
  const counts = searchParams.get('counts');

  if (counts === 'true') {
    const letterCounts = await getLetterCounts(env);
    return json({ letterCounts }, 200, { 'Cache-Control': 'public, max-age=3600' });
  }

  const results = await browseWords(letter, limit, skip, env);
  return json({
    results,
    pagination: { letter, limit, skip }
  });
});

// Word of the day
router.get('/word-of-the-day', async (request, env) => {
  const word = await getWordOfTheDay(env);

  if (!word) {
    return json({ error: 'No word of the day found' }, 404);
  }

  const audio = await getAudio(word.id, env);
  return json({ word, audio });
});

// Random word
router.get('/random-word', async (request, env) => {
  const word = await getRandomWord(env);

  if (!word) {
    return json({ error: 'No words found' }, 404);
  }

  const audio = await getAudio(word.id, env);
  return json({ word, audio });
});

// Random sentence
router.get('/random-sentence', async (request, env) => {
  const sentence = await getRandomSentence(env);

  if (!sentence) {
    return json({ error: 'No sentences found' }, 404);
  }

  return json({ sentence });
});

// Health check
router.get('/', async () => {
  return json({ status: 'ok', service: 'kubishi-dictionary-api' });
});

// Export the worker
export default {
  async fetch(request, env, ctx) {
    return router.handle(request, env);
  }
};
