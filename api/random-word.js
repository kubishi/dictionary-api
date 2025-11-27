import { connectDB, getRandomWord, getAudio } from '../db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await connectDB();
    const word = await getRandomWord();

    if (!word) {
      return res.status(404).json({ error: 'No words found' });
    }

    // Get audio if available
    const audio = await getAudio(word.id);

    res.json({ word, audio });
  } catch (error) {
    console.error('Random word error:', error);
    res.status(500).json({ error: 'Failed to get random word' });
  }
}
