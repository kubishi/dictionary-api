import { MongoClient, Binary } from 'mongodb';
import OpenAI from 'openai';

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

export async function searchEnglish(query, limit = 5) {
  const embedding = await getEmbedding(query);
  const { words } = await getCollections();

  const results = await words.aggregate([
    {
      $vectorSearch: {
        index: 'definitionIndex',
        path: 'embedding',
        queryVector: embedding,
        numCandidates: limit * 20,
        limit
      }
    },
    { $project: { _id: 0, embedding: 0 } }
  ]).toArray();

  return results;
}

export async function searchPaiute(query, limit = 5) {
  const { words } = await getCollections();

  const results = await words.aggregate([
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
    { $limit: limit },
    { $project: { _id: 0, embedding: 0 } }
  ]).toArray();

  return results;
}

export async function searchSentences(query, limit = 5) {
  const embedding = await getEmbedding(query);
  const { sentences } = await getCollections();

  const results = await sentences.aggregate([
    {
      $vectorSearch: {
        index: 'sentenceIndex',
        path: 'embedding',
        queryVector: embedding,
        numCandidates: limit * 20,
        limit
      }
    },
    { $project: { _id: 0, embedding: 0 } }
  ]).toArray();

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
