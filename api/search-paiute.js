import { connectDB, searchPaiute } from '../db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { q, limit = 10, skip = 0 } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  try {
    await connectDB();
    const results = await searchPaiute(q, parseInt(limit), parseInt(skip));
    res.json({ results, pagination: { limit: parseInt(limit), skip: parseInt(skip) } });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
}
