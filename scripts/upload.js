#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import xml2js from 'xml2js';
import { connectDB, getDB, getOpenAI, upsertWord, upsertSentence } from '../db.js';
import dotenv from 'dotenv';

dotenv.config();

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
      lexeme_form: entry['lexical-unit']?.form?.text || null,
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
            const exampleData = {
              source: example.$?.source || null,
              form: example.form?.text || null,
              translation: example.translation?.form?.text || null,
              note: example.note?.form?.text || null
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

async function uploadWords(entries) {
  console.log(`Uploading ${entries.length} words...`);

  let uploaded = 0;
  let updated = 0;

  for (const entry of entries) {
    // Format sources in examples
    for (const sense of entry.senses) {
      for (const example of sense.examples) {
        if (example.source) example.source = formatSource(example.source);
        if (example.note) example.note = formatSource(example.note);
      }
    }

    const result = await upsertWord(entry);
    if (result.upsertedCount > 0) uploaded++;
    if (result.modifiedCount > 0) updated++;
  }

  console.log(`✓ Words uploaded: ${uploaded} new, ${updated} updated`);
}

async function uploadSentences(entries) {
  console.log('Extracting sentences from entries...');

  const sentencesMap = {};

  for (const entry of entries) {
    for (const sense of entry.senses) {
      for (const example of sense.examples) {
        if (!example.form) continue;

        const sentenceText = example.form;
        if (!sentencesMap[sentenceText]) {
          sentencesMap[sentenceText] = {
            id: crypto.createHash('sha256').update(sentenceText).digest('hex'),
            text: sentenceText,
            translation: example.translation || '',
            word_ids: [],
            source: formatSource(example.source || '')
          };
        }

        sentencesMap[sentenceText].word_ids.push(entry.id);
      }
    }
  }

  const sentences = Object.values(sentencesMap);
  console.log(`Uploading ${sentences.length} sentences...`);

  let uploaded = 0;
  let updated = 0;

  for (const sentence of sentences) {
    const result = await upsertSentence(sentence);
    if (result.upsertedCount > 0) uploaded++;
    if (result.modifiedCount > 0) updated++;
  }

  console.log(`✓ Sentences uploaded: ${uploaded} new, ${updated} updated`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: npm run upload <path-to-lift-file>');
    console.error('Example: npm run upload ../kubishi_dictionary/scripts/upload/ovp_dict.lift');
    process.exit(1);
  }

  const liftFile = path.resolve(args[0]);

  if (!fs.existsSync(liftFile)) {
    console.error(`Error: File not found: ${liftFile}`);
    process.exit(1);
  }

  console.log(`📖 Parsing LIFT file: ${liftFile}`);

  try {
    await connectDB();

    const xmlEntries = await parseLiftFile(liftFile);
    const entries = extractEntries(Array.isArray(xmlEntries) ? xmlEntries : [xmlEntries]);

    console.log(`Found ${entries.length} entries`);

    await uploadWords(entries);
    await uploadSentences(entries);

    console.log('\n✅ Upload complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Upload failed:', error);
    process.exit(1);
  }
}

main();
