import { MongoClient, Binary } from 'mongodb';
import OpenAI from 'openai';

const EMBEDDING_MODEL = 'text-embedding-3-small';

// Global client - will be reused within same isolate
let client = null;

export async function connectToDatabase(env) {
  // Create new client if none exists
  if (!client) {
    client = new MongoClient(env.MONGO_URI, {
      maxPoolSize: 1,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
  }

  // Connect if not connected (this is idempotent if already connected)
  try {
    await client.connect();
  } catch (e) {
    // If connection failed, reset client and try again
    client = null;
    client = new MongoClient(env.MONGO_URI, {
      maxPoolSize: 1,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    await client.connect();
  }

  const db = client.db(env.MONGO_DB);
  return { client, db };
}

export async function getCollections(env) {
  const { db } = await connectToDatabase(env);
  return {
    words: db.collection('words'),
    audios: db.collection('audios'),
    sentences: db.collection('sentences'),
    metadata: db.collection('metadata')
  };
}

// OpenAI embeddings
export async function getEmbedding(text, env) {
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text
  });
  return response.data[0].embedding;
}

export function vectorToBinary(vector) {
  const buffer = new Float32Array(vector).buffer;
  return new Binary(Buffer.from(buffer), Binary.SUBTYPE_BYTE_ARRAY);
}

// Helper to filter out invalid entries
function isValidEntry(entry) {
  if (!entry.word && !entry.lexical_unit) {
    return false;
  }

  if (!entry.senses || entry.senses.length === 0) {
    return false;
  }

  const hasValidSense = entry.senses.some(sense => sense.gloss || sense.definition);
  return hasValidSense;
}

// Database queries
export async function getWordById(wordId, env) {
  const { words } = await getCollections(env);
  return await words.findOne(
    { id: wordId },
    { projection: { _id: 0, embedding: 0 } }
  );
}

export async function searchEnglish(query, limit, skip, env) {
  const embedding = await getEmbedding(query, env);
  const { words } = await getCollections(env);

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

export async function searchPaiute(query, limit, skip, env) {
  const { words } = await getCollections(env);

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

export async function searchSentences(query, limit, skip, env) {
  const embedding = await getEmbedding(query, env);
  const { sentences } = await getCollections(env);

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

export async function getAudiosByWordId(wordId, env) {
  const { audios } = await getCollections(env);
  return await audios.find(
    { word_ids: wordId },
    { projection: { _id: 0 } }
  ).toArray();
}

export async function getWordOfTheDay(env) {
  const today = new Date().toISOString().split('T')[0];
  const { metadata, words } = await getCollections(env);

  const wotd = await metadata.findOne({ key: 'word_of_the_day', date: today });

  if (wotd) {
    return await getWordById(wotd.word_id, env);
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

  const randomWord = wordsWithExamples[0] || await getRandomWord(env);

  if (randomWord) {
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

export async function getRandomWord(env) {
  const { words } = await getCollections(env);

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

export async function getRandomSentence(env) {
  const { sentences } = await getCollections(env);

  const randomSentences = await sentences.aggregate([
    { $sample: { size: 1 } },
    { $project: { _id: 0, embedding: 0 } }
  ]).toArray();

  return randomSentences[0] || null;
}

export async function browseWords(letter, limit, skip, env) {
  const { words } = await getCollections(env);

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

  let filteredWords = allWords;

  if (letter) {
    filteredWords = allWords.filter(word => {
      const text = word.lexical_unit || word.word || '';
      const match = text.match(/[a-zA-Z]/);
      return match && match[0].toUpperCase() === letter.toUpperCase();
    });
  }

  filteredWords.sort((a, b) => {
    const aText = (a.lexical_unit || a.word || '').toLowerCase();
    const bText = (b.lexical_unit || b.word || '').toLowerCase();
    return aText.localeCompare(bText);
  });

  return filteredWords.slice(skip, skip + limit);
}

export async function getLetterCounts(env) {
  const { words } = await getCollections(env);

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

  const counts = {};
  for (const word of allWords) {
    const text = word.lexical_unit || word.word || '';
    const match = text.match(/[a-zA-Z]/);
    if (match) {
      const letter = match[0].toUpperCase();
      counts[letter] = (counts[letter] || 0) + 1;
    }
  }

  return Object.entries(counts)
    .map(([letter, count]) => ({ letter, count }))
    .sort((a, b) => a.letter.localeCompare(b.letter));
}

export async function getAudio(wordId, env) {
  const audios = await getAudiosByWordId(wordId, env);
  return audios[0] || null;
}
