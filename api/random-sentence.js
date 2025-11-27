import { connectDB, getRandomSentence } from '../db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await connectDB();
    const sentence = await getRandomSentence();

    if (!sentence) {
      return res.status(404).json({ error: 'No sentences found' });
    }

    res.json({ sentence });
  } catch (error) {
    console.error('Random sentence error:', error);
    res.status(500).json({ error: 'Failed to get random sentence' });
  }
}
