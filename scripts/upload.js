#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import xml2js from 'xml2js';
import { MongoClient, Binary } from 'mongodb';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const EMBEDDING_MODEL = 'text-embedding-3-small';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Local embedding cache directory
const CACHE_DIR = path.join(os.homedir(), '.kubishi-dictionary', 'embeddings');
const BACKUP_DIR = path.join(os.homedir(), '.kubishi', 'backups');

// Ensure cache directory exists
function ensureCacheDir(cacheName) {
  const dir = path.join(CACHE_DIR, cacheName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Ensure backup directory exists
function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  return BACKUP_DIR;
}

// Get embedding from cache or compute and cache it
async function getCachedEmbedding(text, cacheName) {
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const cacheDir = ensureCacheDir(cacheName);
  const cachePath = path.join(cacheDir, `${hash}.json`);

  // Check cache
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      return cached.embedding;
    } catch (err) {
      // Cache corrupted, recompute
    }
  }

  // Compute embedding
  const embedding = await getEmbedding(text);

  // Save to cache
  fs.writeFileSync(cachePath, JSON.stringify({ text, embedding }));

  return embedding;
}

// Database connection (separate from main db.js to allow custom db name)
let client = null;
let db = null;

async function connectToDatabase(dbName) {
  if (db) return db;

  client = await MongoClient.connect(process.env.MONGO_URI);
  db = client.db(dbName);
  console.log(`Connected to database: ${dbName}`);
  return db;
}

async function closeConnection() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

// Embedding functions
async function getEmbedding(text) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text
  });
  return response.data[0].embedding;
}

function vectorToBinary(vector) {
  const buffer = new Float32Array(vector).buffer;
  return new Binary(Buffer.from(buffer), Binary.SUBTYPE_BYTE_ARRAY);
}

// XML parsing
async function parseLiftFile(filePath) {
  const xml = fs.readFileSync(filePath, 'utf-8');
  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(xml);
  return result.lift.entry || [];
}

function extractEntries(xmlEntries) {
  const entries = [];

  for (const entry of xmlEntries) {
    if (!entry) continue;

    const entryData = {
      id: entry.$.id,
      dateCreated: entry.$.dateCreated,
      dateModified: entry.$.dateModified,
      guid: entry.$.guid,
      lexical_unit: entry['lexical-unit']?.form?.text || null,
      word: entry['lexical-unit']?.form?.text || null,
      traits: {},
      senses: []
    };

    // Traits
    if (entry.trait) {
      const traits = Array.isArray(entry.trait) ? entry.trait : [entry.trait];
      for (const trait of traits) {
        if (trait.$) {
          entryData.traits[trait.$.name] = trait.$.value;
        }
      }
    }

    // Senses
    if (entry.sense) {
      const senses = Array.isArray(entry.sense) ? entry.sense : [entry.sense];
      for (const sense of senses) {
        const senseData = {
          id: sense.$.id,
          grammatical_info: sense['grammatical-info']?.$?.value || null,
          gloss: sense.gloss?.text || null,
          definition: sense.definition?.form?.text || null,
          examples: []
        };

        // Examples
        if (sense.example) {
          const examples = Array.isArray(sense.example) ? sense.example : [sense.example];
          for (const example of examples) {
            // Handle form - can be object or array
            let formText = null;
            if (example.form) {
              const form = Array.isArray(example.form) ? example.form[0] : example.form;
              formText = form?.text || null;
            }

            // Handle translation - can be object or array
            let translationText = null;
            if (example.translation) {
              const translation = Array.isArray(example.translation) ? example.translation[0] : example.translation;
              const transForm = translation?.form;
              if (transForm) {
                const tf = Array.isArray(transForm) ? transForm[0] : transForm;
                translationText = tf?.text || null;
              }
            }

            // Handle note - can be object or array
            let noteText = null;
            if (example.note) {
              const note = Array.isArray(example.note) ? example.note[0] : example.note;
              const noteForm = note?.form;
              if (noteForm) {
                const nf = Array.isArray(noteForm) ? noteForm[0] : noteForm;
                noteText = nf?.text || null;
              }
            }

            const exampleData = {
              source: example.$?.source || null,
              form: formText,
              translation: translationText,
              note: noteText
            };
            senseData.examples.push(exampleData);
          }
        }

        entryData.senses.push(senseData);
      }
    }

    entries.push(entryData);
  }

  return entries;
}

function formatSource(source) {
  if (!source) return '';
  return source.replace(/\bnn\b/g, 'Norma Nelson');
}

async function uploadWords(entries, wordsCollection, sourceWordsMap = null) {
  console.log(`\nUploading ${entries.length} words...`);

  // sourceWordsMap is now passed in directly (already built from backup)
  if (sourceWordsMap && sourceWordsMap.size > 0) {
    console.log(`  Found ${sourceWordsMap.size} existing words for embedding reuse`);
  }

  const documents = [];
  let reusedEmbeddings = 0;
  let newEmbeddings = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // Format sources in examples
    for (const sense of entry.senses) {
      for (const example of sense.examples) {
        if (example.source) example.source = formatSource(example.source);
        if (example.note) example.note = formatSource(example.note);
      }
    }

    // Check if we can reuse existing embedding from source db
    const sourceWord = sourceWordsMap.get(entry.id);
    if (sourceWord && sourceWord.embedding && sourceWord.dateModified === entry.dateModified) {
      // Word unchanged, reuse embedding from source db
      entry.embedding = sourceWord.embedding;
      reusedEmbeddings++;
    } else {
      // Need to compute new embedding (check local cache first)
      const textToEmbed = [
        entry.word || entry.lexical_unit,
        ...entry.senses.map(s => s.gloss).filter(Boolean),
        ...entry.senses.map(s => s.definition).filter(Boolean)
      ].join(' ');

      try {
        const embedding = await getCachedEmbedding(textToEmbed, 'words');
        entry.embedding = vectorToBinary(embedding);
        newEmbeddings++;
      } catch (err) {
        console.error(`\n  Warning: Failed to get embedding for ${entry.id}: ${err.message}`);
      }
    }

    entry.created_at = new Date();
    entry.updated_at = new Date();
    documents.push(entry);

    // Progress indicator
    if ((i + 1) % 50 === 0 || i === entries.length - 1) {
      process.stdout.write(`\r  Processing words: ${i + 1}/${entries.length} (reused: ${reusedEmbeddings}, new: ${newEmbeddings})`);
    }
  }

  console.log('\n  Inserting into database...');
  const result = await wordsCollection.insertMany(documents);
  console.log(`  Inserted ${result.insertedCount} words`);
  console.log(`  Embeddings: ${reusedEmbeddings} reused, ${newEmbeddings} computed`);

  // Create indexes
  console.log('  Creating indexes...');
  await wordsCollection.createIndex({ id: 1 }, { unique: true });
  await wordsCollection.createIndex({ guid: 1 });
  await wordsCollection.createIndex({ lexical_unit: 1 });

  return result;
}

async function uploadSentences(entries, sentencesCollection, sourceSentencesMap = null) {
  console.log('\nExtracting sentences from entries...');

  const sentencesMap = {};

  for (const entry of entries) {
    for (const sense of entry.senses) {
      for (const example of sense.examples) {
        // Ensure we have a string, default to empty string if invalid
        let sentenceText = '';
        if (example.form) {
          if (typeof example.form === 'string') {
            sentenceText = example.form;
          } else if (typeof example.form === 'object' && example.form.text) {
            sentenceText = example.form.text;
          }
        }

        // Skip if no valid sentence text
        if (!sentenceText) continue;

        if (!sentencesMap[sentenceText]) {
          sentencesMap[sentenceText] = {
            id: crypto.createHash('sha256').update(sentenceText).digest('hex'),
            sentence: sentenceText,
            text: sentenceText,
            translation: example.translation || '',
            word_ids: [],
            source: formatSource(example.source || '')
          };
        }

        if (!sentencesMap[sentenceText].word_ids.includes(entry.id)) {
          sentencesMap[sentenceText].word_ids.push(entry.id);
        }
      }
    }
  }

  const sentences = Object.values(sentencesMap);
  console.log(`Uploading ${sentences.length} sentences...`);

  // sourceSentencesMap is now passed in directly (already built from backup)
  if (sourceSentencesMap && sourceSentencesMap.size > 0) {
    console.log(`  Found ${sourceSentencesMap.size} existing sentences for embedding reuse`);
  }

  let reusedEmbeddings = 0;
  let newEmbeddings = 0;

  // Generate embeddings for sentences
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];

    // Check if we can reuse existing embedding from source db (same id means same text hash)
    const sourceSentence = sourceSentencesMap.get(sentence.id);
    if (sourceSentence && sourceSentence.embedding) {
      // Sentence unchanged (same hash), reuse embedding from source db
      sentence.embedding = sourceSentence.embedding;
      reusedEmbeddings++;
    } else {
      // Need to compute new embedding (check local cache first)
      const textToEmbed = `${sentence.text} ${sentence.translation}`;

      try {
        const embedding = await getCachedEmbedding(textToEmbed, 'sentences');
        sentence.embedding = vectorToBinary(embedding);
        newEmbeddings++;
      } catch (err) {
        console.error(`  Warning: Failed to get embedding for sentence: ${err.message}`);
      }
    }

    sentence.created_at = new Date();
    sentence.updated_at = new Date();

    // Progress indicator
    if ((i + 1) % 100 === 0 || i === sentences.length - 1) {
      process.stdout.write(`\r  Processing sentences: ${i + 1}/${sentences.length} (reused: ${reusedEmbeddings}, new: ${newEmbeddings})`);
    }
  }

  console.log('\n  Inserting into database...');
  const result = await sentencesCollection.insertMany(sentences);
  console.log(`  Inserted ${result.insertedCount} sentences`);
  console.log(`  Embeddings: ${reusedEmbeddings} reused, ${newEmbeddings} computed`);

  // Create indexes
  console.log('  Creating indexes...');
  await sentencesCollection.createIndex({ id: 1 }, { unique: true });
  await sentencesCollection.createIndex({ sentence: 1 });

  return result;
}

function printUsage() {
  console.log(`
Usage: node scripts/upload.js <path-to-lift-file> [options]

Options:
  --db <name>       Target database name (default: from MONGO_DB env var)
  --backup          Backup current collections to JSON files before uploading (recommended)
  --no-backup       Skip backup (use with caution)
  --help            Show this help message

Backups are saved to: ~/.kubishi/backups/

Examples:
  # Upload with backup (safe - backups saved to ~/.kubishi/backups/)
  node scripts/upload.js ../data/ovp_dict.lift --backup

  # Upload without backup (faster, but no rollback)
  node scripts/upload.js ../data/ovp_dict.lift --no-backup
`);
}

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let liftFilePath = null;
  let dbName = process.env.MONGO_DB;
  let doBackup = null; // null = not specified, true = backup, false = no backup

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      printUsage();
      process.exit(0);
    } else if (args[i] === '--db') {
      dbName = args[++i];
    } else if (args[i] === '--backup') {
      doBackup = true;
    } else if (args[i] === '--no-backup') {
      doBackup = false;
    } else if (!args[i].startsWith('-')) {
      liftFilePath = args[i];
    }
  }

  if (!liftFilePath) {
    console.error('Error: No LIFT file specified');
    printUsage();
    process.exit(1);
  }

  const liftFile = path.resolve(liftFilePath);

  if (!fs.existsSync(liftFile)) {
    console.error(`Error: File not found: ${liftFile}`);
    process.exit(1);
  }

  if (!dbName) {
    console.error('Error: No database name specified. Use --db <name> or set MONGO_DB env var');
    process.exit(1);
  }

  if (doBackup === null) {
    console.error('Error: Please specify --backup or --no-backup');
    printUsage();
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('Dictionary Upload Script');
  console.log('='.repeat(60));
  console.log(`LIFT file: ${liftFile}`);
  console.log(`Target database: ${dbName}`);
  console.log(`Backup: ${doBackup ? `Yes (current data will be saved to ${BACKUP_DIR})` : 'No'}`);
  console.log('='.repeat(60));

  // Confirmation for safety
  console.log(`\nThis will REPLACE all data in the words and sentences collections.`);
  if (doBackup) {
    console.log(`Current data will be backed up to JSON files in ${BACKUP_DIR}`);
  } else {
    console.log('WARNING: No backup will be made. Current data will be LOST.');
  }
  console.log('Press Ctrl+C within 5 seconds to cancel...\n');
  await new Promise(resolve => setTimeout(resolve, 5000));

  try {
    const database = await connectToDatabase(dbName);
    const wordsCollection = database.collection('words');
    const sentencesCollection = database.collection('sentences');
    const metadataCollection = database.collection('metadata');

    // Keep references to existing collections for embedding reuse
    let sourceWordsMap = new Map();
    let sourceSentencesMap = new Map();

    // Backup current collections if requested
    if (doBackup) {
      console.log('Backing up current collections to files...');
      ensureBackupDir();
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
      const wordsBackupPath = path.join(BACKUP_DIR, `words_${timestamp}.json`);
      const sentencesBackupPath = path.join(BACKUP_DIR, `sentences_${timestamp}.json`);

      // Backup words collection
      try {
        const wordsCount = await wordsCollection.countDocuments();
        if (wordsCount > 0) {
          console.log(`  Exporting ${wordsCount} words to ${wordsBackupPath}...`);
          const words = await wordsCollection.find({}).toArray();
          
          // Build map for embedding reuse before backup
          for (const word of words) {
            sourceWordsMap.set(word.id, word);
          }
          
          fs.writeFileSync(wordsBackupPath, JSON.stringify(words, null, 2));
          console.log(`  ✓ Words backed up`);
        } else {
          console.log('  No words to backup (collection empty)');
        }
      } catch (err) {
        console.log(`  Words collection not found (first upload?)`);
      }

      // Backup sentences collection
      try {
        const sentencesCount = await sentencesCollection.countDocuments();
        if (sentencesCount > 0) {
          console.log(`  Exporting ${sentencesCount} sentences to ${sentencesBackupPath}...`);
          const sentences = await sentencesCollection.find({}).toArray();
          
          // Build map for embedding reuse before backup
          for (const sentence of sentences) {
            sourceSentencesMap.set(sentence.id, sentence);
          }
          
          fs.writeFileSync(sentencesBackupPath, JSON.stringify(sentences, null, 2));
          console.log(`  ✓ Sentences backed up`);
        } else {
          console.log('  No sentences to backup (collection empty)');
        }
      } catch (err) {
        console.log(`  Sentences collection not found (first upload?)`);
      }
    }

    // Drop the collections
    console.log('Dropping existing collections...');
    await wordsCollection.drop().catch(() => {});
    await sentencesCollection.drop().catch(() => {});
    console.log('Collections dropped');

    // Parse XML
    console.log(`\nParsing LIFT file...`);
    const xmlEntries = await parseLiftFile(liftFile);
    const entries = extractEntries(Array.isArray(xmlEntries) ? xmlEntries : [xmlEntries]);
    console.log(`Found ${entries.length} entries`);

    // Upload (passing the maps for embedding reuse)
    await uploadWords(entries, wordsCollection, sourceWordsMap);
    await uploadSentences(entries, sentencesCollection, sourceSentencesMap);

    // Create metadata collection index
    await metadataCollection.createIndex({ key: 1 }, { unique: true });

    // Summary
    const wordCount = await wordsCollection.countDocuments();
    const sentenceCount = await sentencesCollection.countDocuments();

    console.log('\n' + '='.repeat(60));
    console.log('Upload Complete!');
    console.log('='.repeat(60));
    console.log(`Database: ${dbName}`);
    console.log(`Words: ${wordCount}`);
    console.log(`Sentences: ${sentenceCount}`);
    if (doBackup) {
      console.log(`Backups saved to: ${BACKUP_DIR}`);
    }
    console.log('='.repeat(60));

    if (doBackup) {
      console.log(`
To restore from a backup, you can use mongoimport or the rollback script:
  node scripts/rollback.js <backup-timestamp>
`);
    }

    await closeConnection();
    process.exit(0);
  } catch (error) {
    console.error('\nUpload failed:', error);
    await closeConnection();
    process.exit(1);
  }
}

main();
