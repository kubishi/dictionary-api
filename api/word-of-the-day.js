import { connectDB, getWordOfTheDay, getAudio } from '../db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await connectDB();
    const word = await getWordOfTheDay();

    if (!word) {
      return res.status(404).json({ error: 'No word of the day found' });
    }

    // Get audio if available
    const audio = await getAudio(word.id);

    res.json({ word, audio });
  } catch (error) {
    console.error('Word of the day error:', error);
    res.status(500).json({ error: 'Failed to get word of the day' });
  }
}
