import { MongoClient, Binary } from 'mongodb';
import OpenAI from 'openai';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_SIZE = 1536;

let cachedClient = null;
let cachedDb = null;

export async function connectToDatabase() {
  if (cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }

  const client = await MongoClient.connect(process.env.MONGO_URI);
  const db = client.db(process.env.MONGO_DB);

  cachedClient = client;
  cachedDb = db;

  return { client, db };
}

export async function getCollections() {
  const { db } = await connectToDatabase();
  return {
    words: db.collection('words'),
    audios: db.collection('audios'),
    sentences: db.collection('sentences'),
    metadata: db.collection('metadata')
  };
}

// OpenAI embeddings
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getEmbedding(text) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text
  });
  return response.data[0].embedding;
}

export async function getEmbeddings(texts, chunkSize = 100) {
  const embeddings = [];
  for (let i = 0; i < texts.length; i += chunkSize) {
    const chunk = texts.slice(i, i + chunkSize);
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: chunk
    });
    embeddings.push(...response.data.map(d => d.embedding));
  }
  return embeddings;
}

export function vectorToBinary(vector) {
  const buffer = new Float32Array(vector).buffer;
  return new Binary(Buffer.from(buffer), Binary.SUBTYPE_BYTE_ARRAY);
}

// Helper to filter out invalid entries
function isValidEntry(entry) {
  // Must have either word or lexical_unit
  if (!entry.word && !entry.lexical_unit) {
    return false;
  }
  
  // Must have at least one sense with gloss or definition
  if (!entry.senses || entry.senses.length === 0) {
    return false;
  }
  
  const hasValidSense = entry.senses.some(sense => sense.gloss || sense.definition);
  return hasValidSense;
}

// Database queries
export async function getWordById(wordId) {
  const { words } = await getCollections();
  return await words.findOne(
    { id: wordId },
    { projection: { _id: 0, embedding: 0 } }
  );
}

export async function searchEnglish(query, limit = 5, skip = 0) {
  const embedding = await getEmbedding(query);
  const { words } = await getCollections();

  const pipeline = [
    {
      $vectorSearch: {
        index: 'definitionIndex',
        path: 'embedding',
        queryVector: embedding,
        numCandidates: (limit + skip) * 20,
        limit: limit + skip
      }
    },
    { $project: { _id: 0, embedding: 0 } }
  ];

  if (skip > 0) {
    pipeline.push({ $skip: skip });
  }

  const results = await words.aggregate(pipeline).toArray();

  return results.filter(isValidEntry);
}

export async function searchPaiute(query, limit = 5, skip = 0) {
  const { words } = await getCollections();

  const pipeline = [
    {
      $search: {
        index: 'default',
        text: {
          query,
          fuzzy: {},
          path: 'lexical_unit'
        }
      }
    },
    { $project: { _id: 0, embedding: 0 } }
  ];

  if (skip > 0) {
    pipeline.push({ $skip: skip });
  }

  pipeline.push({ $limit: limit });

  const results = await words.aggregate(pipeline).toArray();

  return results.filter(isValidEntry);
}

export async function searchSentences(query, limit = 5, skip = 0) {
  const embedding = await getEmbedding(query);
  const { sentences } = await getCollections();

  const pipeline = [
    {
      $vectorSearch: {
        index: 'sentenceIndex',
        path: 'embedding',
        queryVector: embedding,
        numCandidates: (limit + skip) * 20,
        limit: limit + skip
      }
    },
    { $project: { _id: 0, embedding: 0 } }
  ];

  if (skip > 0) {
    pipeline.push({ $skip: skip });
  }

  const results = await sentences.aggregate(pipeline).toArray();

  return results;
}

export async function getSentenceById(sentenceId) {
  const { sentences } = await getCollections();
  return await sentences.findOne(
    { id: sentenceId },
    { projection: { _id: 0, embedding: 0 } }
  );
}

export async function getAudiosByWordId(wordId) {
  const { audios } = await getCollections();
  return await audios.find(
    { word_ids: wordId },
    { projection: { _id: 0 } }
  ).toArray();
}

export async function getWordOfTheDay() {
  console.log('Fetching word of the day...');
  const today = new Date().toISOString().split('T')[0];
  const { metadata, words } = await getCollections();

  // Check if we already have a word of the day for today
  const wotd = await metadata.findOne({ key: 'word_of_the_day', date: today });

  console.log('WOTD record:', wotd);

  if (wotd) {
    return await getWordById(wotd.word_id);
  }

  // No word for today - pick a random one (prefer words with examples)
  const wordsWithExamples = await words.aggregate([
    {
      $match: {
        'senses.examples.0': { $exists: true },
        $or: [
          { word: { $ne: null } },
          { lexical_unit: { $ne: null } }
        ],
        senses: {
          $elemMatch: {
            $or: [
              { gloss: { $ne: null } },
              { definition: { $ne: null } }
            ]
          }
        }
      }
    },
    { $sample: { size: 1 } },
    { $project: { _id: 0, embedding: 0 } }
  ]).toArray();

  const randomWord = wordsWithExamples[0] || await getRandomWord();

  if (randomWord) {
    // Save as today's word of the day
    await metadata.updateOne(
      { key: 'word_of_the_day' },
      {
        $set: {
          date: today,
          word_id: randomWord.id,
          updated_at: new Date()
        }
      },
      { upsert: true }
    );
  }

  return randomWord;
}

export async function getRandomWord() {
  const { words } = await getCollections();

  const randomWords = await words.aggregate([
    {
      $match: {
        $or: [
          { word: { $ne: null } },
          { lexical_unit: { $ne: null } }
        ],
        senses: {
          $elemMatch: {
            $or: [
              { gloss: { $ne: null } },
              { definition: { $ne: null } }
            ]
          }
        }
      }
    },
    { $sample: { size: 1 } },
    { $project: { _id: 0, embedding: 0 } }
  ]).toArray();

  return randomWords[0] || null;
}

export async function getRandomSentence() {
  const { sentences } = await getCollections();

  const randomSentences = await sentences.aggregate([
    { $sample: { size: 1 } },
    { $project: { _id: 0, embedding: 0 } }
  ]).toArray();

  return randomSentences[0] || null;
}

// Aliases for compatibility
export const connectDB = connectToDatabase;
export const getDB = async () => {
  const { db } = await connectToDatabase();
  return db;
};
export const getOpenAI = () => openai;
export const searchWords = searchEnglish;
export const getAudio = async (wordId) => {
  const audios = await getAudiosByWordId(wordId);
  return audios[0] || null;
};

// Upload functions
export async function upsertWord(wordData) {
  const { word, lexeme_form, ...data } = wordData;
  const { words } = await getCollections();

  // Generate embedding
  const textToEmbed = [
    word || lexeme_form,
    ...data.senses.map(s => s.gloss).filter(Boolean),
    ...data.senses.map(s => s.definition).filter(Boolean)
  ].join(' ');

  const embedding = await getEmbedding(textToEmbed);
  const binaryEmbedding = vectorToBinary(embedding);

  const doc = {
    word,
    lexeme_form,
    ...data,
    embedding: binaryEmbedding,
    updated_at: new Date()
  };

  const result = await words.updateOne(
    { word, lexeme_form },
    { $set: doc, $setOnInsert: { created_at: new Date() } },
    { upsert: true }
  );

  return result;
}

export async function browseWords(letter = null, limit = 50, skip = 0) {
  const { words } = await getCollections();
  
  // Get all valid words with only necessary fields
  const allWords = await words.find({
    $or: [
      { word: { $ne: null } },
      { lexical_unit: { $ne: null } }
    ],
    senses: {
      $elemMatch: {
        $or: [
          { gloss: { $ne: null } },
          { definition: { $ne: null } }
        ]
      }
    }
  }, {
    projection: { 
      _id: 0, 
      embedding: 0,
      'senses.examples': 0,
      dateCreated: 0,
      dateModified: 0,
      guid: 0,
      traits: 0,
      created_at: 0,
      updated_at: 0
    }
  }).toArray();

  // Filter by first alphabetic character and sort
  let filteredWords = allWords;
  
  if (letter) {
    filteredWords = allWords.filter(word => {
      const text = word.lexical_unit || word.word || '';
      const match = text.match(/[a-zA-Z]/);
      return match && match[0].toUpperCase() === letter.toUpperCase();
    });
  }

  // Sort by lexical_unit or word
  filteredWords.sort((a, b) => {
    const aText = (a.lexical_unit || a.word || '').toLowerCase();
    const bText = (b.lexical_unit || b.word || '').toLowerCase();
    return aText.localeCompare(bText);
  });

  // Apply pagination
  return filteredWords.slice(skip, skip + limit);
}

export async function getLetterCounts() {
  const { words } = await getCollections();
  
  // Get all valid words
  const allWords = await words.find({
    $or: [
      { word: { $ne: null } },
      { lexical_unit: { $ne: null } }
    ],
    senses: {
      $elemMatch: {
        $or: [
          { gloss: { $ne: null } },
          { definition: { $ne: null } }
        ]
      }
    }
  }).toArray();

  // Count by first alphabetic character
  const counts = {};
  for (const word of allWords) {
    const text = word.lexical_unit || word.word || '';
    // Find first alphabetic character
    const match = text.match(/[a-zA-Z]/);
    if (match) {
      const letter = match[0].toUpperCase();
      counts[letter] = (counts[letter] || 0) + 1;
    }
  }

  // Convert to array and sort
  return Object.entries(counts)
    .map(([letter, count]) => ({ letter, count }))
    .sort((a, b) => a.letter.localeCompare(b.letter));
}

export async function upsertSentence(sentenceData) {
  const { text, translation, ...data } = sentenceData;
  const { sentences } = await getCollections();

  const textToEmbed = `${text} ${translation}`;
  const embedding = await getEmbedding(textToEmbed);
  const binaryEmbedding = vectorToBinary(embedding);

  const doc = {
    text,
    translation,
    ...data,
    embedding: binaryEmbedding,
    updated_at: new Date()
  };

  const result = await sentences.updateOne(
    { text },
    { $set: doc, $setOnInsert: { created_at: new Date() } },
    { upsert: true }
  );

  return result;
}
