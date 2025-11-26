import { connectDB, getWordById, getAudio } from '../../db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;

  try {
    await connectDB();
    const word = await getWordById(id);

    if (!word) {
      return res.status(404).json({ error: 'Word not found' });
    }

    // Try to get audio
    const audio = await getAudio(word.word || word.lexeme_form);

    res.json({ word, audio });
  } catch (error) {
    console.error('Get word error:', error);
    res.status(500).json({ error: 'Failed to get word' });
  }
}
