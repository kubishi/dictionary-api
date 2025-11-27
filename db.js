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

  return results;
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

  return results;
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
  const today = new Date().toISOString().split('T')[0];
  const { metadata, words } = await getCollections();

  let wotd = await metadata.findOne({ key: 'word_of_the_day', date: today });

  if (wotd) {
    return await getWordById(wotd.word_id);
  }

  // Get random word with examples
  const randomWords = await words.aggregate([
    { $match: { 'senses.examples': { $exists: true, $ne: [] } } },
    { $sample: { size: 1 } },
    { $project: { _id: 0, embedding: 0 } }
  ]).toArray();

  if (randomWords.length > 0) {
    const word = randomWords[0];
    await metadata.updateOne(
      { key: 'word_of_the_day' },
      { $set: { key: 'word_of_the_day', date: today, word_id: word.id } },
      { upsert: true }
    );
    return word;
  }

  return null;
}

export async function getRandomWord() {
  const { words } = await getCollections();

  const randomWords = await words.aggregate([
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
