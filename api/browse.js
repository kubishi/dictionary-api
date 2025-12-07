import { connectDB, browseWords, getLetterCounts } from '../db.js';

// Cache for letter counts (expires after 1 hour)
let letterCountsCache = null;
let letterCountsCacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { letter, limit = 50, skip = 0, counts } = req.query;

  try {
    await connectDB();

    // If requesting letter counts
    if (counts === 'true' || counts === true) {
      // Check cache
      const now = Date.now();
      if (letterCountsCache && (now - letterCountsCacheTime) < CACHE_TTL) {
        // Set cache headers
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.json({ letterCounts: letterCountsCache });
      }

      // Fetch fresh data
      const letterCounts = await getLetterCounts();
      
      // Update cache
      letterCountsCache = letterCounts;
      letterCountsCacheTime = now;
      
      // Set cache headers
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.json({ letterCounts });
    }

    // Browse words
    const results = await browseWords(
      letter || null,
      parseInt(limit),
      parseInt(skip)
    );

    res.json({
      results,
      pagination: {
        letter: letter || null,
        limit: parseInt(limit),
        skip: parseInt(skip)
      }
    });
  } catch (error) {
    console.error('Browse error:', error);
    res.status(500).json({ error: 'Browse failed' });
  }
}
