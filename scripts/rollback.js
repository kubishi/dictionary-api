#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const BACKUP_DIR = path.join(os.homedir(), '.kubishi', 'backups');

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  return BACKUP_DIR;
}

function listBackupFiles() {
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_DIR);
  const backups = new Map();

  for (const file of files) {
    const match = file.match(/^(words|sentences)_(.+)\.json$/);
    if (match) {
      const [, type, timestamp] = match;
      if (!backups.has(timestamp)) {
        backups.set(timestamp, { timestamp, words: false, sentences: false });
      }
      backups.get(timestamp)[type] = true;
    }
  }

  return Array.from(backups.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

async function saveCurrentState(db, label) {
  console.log(`\nSaving current state (${label})...`);
  ensureBackupDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
  const wordsBackupPath = path.join(BACKUP_DIR, `words_${timestamp}_${label}.json`);
  const sentencesBackupPath = path.join(BACKUP_DIR, `sentences_${timestamp}_${label}.json`);

  const wordsCollection = db.collection('words');
  const sentencesCollection = db.collection('sentences');

  try {
    const wordsCount = await wordsCollection.countDocuments();
    if (wordsCount > 0) {
      console.log(`  Exporting ${wordsCount} words...`);
      const words = await wordsCollection.find({}).toArray();
      fs.writeFileSync(wordsBackupPath, JSON.stringify(words, null, 2));
      console.log(`  ✓ Saved to ${wordsBackupPath}`);
    }
  } catch (err) {
    console.log(`  Could not save words: ${err.message}`);
  }

  try {
    const sentencesCount = await sentencesCollection.countDocuments();
    if (sentencesCount > 0) {
      console.log(`  Exporting ${sentencesCount} sentences...`);
      const sentences = await sentencesCollection.find({}).toArray();
      fs.writeFileSync(sentencesBackupPath, JSON.stringify(sentences, null, 2));
      console.log(`  ✓ Saved to ${sentencesBackupPath}`);
    }
  } catch (err) {
    console.log(`  Could not save sentences: ${err.message}`);
  }
}

async function restoreFromBackup(db, timestamp) {
  const wordsBackupPath = path.join(BACKUP_DIR, `words_${timestamp}.json`);
  const sentencesBackupPath = path.join(BACKUP_DIR, `sentences_${timestamp}.json`);

  const wordsCollection = db.collection('words');
  const sentencesCollection = db.collection('sentences');

  console.log('\nRestoring from backup...');

  // Clear current collections (preserve indexes including vector search)
  const deletedWords = await wordsCollection.deleteMany({});
  const deletedSentences = await sentencesCollection.deleteMany({});
  console.log(`  Cleared ${deletedWords.deletedCount} words, ${deletedSentences.deletedCount} sentences`);

  // Restore words
  if (fs.existsSync(wordsBackupPath)) {
    console.log(`  Loading words from ${wordsBackupPath}...`);
    const words = JSON.parse(fs.readFileSync(wordsBackupPath, 'utf-8'));
    if (words.length > 0) {
      await wordsCollection.insertMany(words);
      console.log(`  ✓ Restored ${words.length} words`);

      // Recreate indexes (skip if they already exist)
      try {
        await wordsCollection.createIndex({ id: 1 }, { unique: true });
      } catch (err) {
        if (err.code !== 86) throw err;
      }
      try {
        await wordsCollection.createIndex({ guid: 1 });
      } catch (err) {
        if (err.code !== 86) throw err;
      }
      try {
        await wordsCollection.createIndex({ lexical_unit: 1 });
      } catch (err) {
        if (err.code !== 86) throw err;
      }
    }
  } else {
    console.log(`  Warning: Words backup file not found`);
  }

  // Restore sentences
  if (fs.existsSync(sentencesBackupPath)) {
    console.log(`  Loading sentences from ${sentencesBackupPath}...`);
    const sentences = JSON.parse(fs.readFileSync(sentencesBackupPath, 'utf-8'));
    if (sentences.length > 0) {
      await sentencesCollection.insertMany(sentences);
      console.log(`  ✓ Restored ${sentences.length} sentences`);

      // Recreate indexes (skip if they already exist)
      try {
        await sentencesCollection.createIndex({ id: 1 }, { unique: true });
      } catch (err) {
        if (err.code !== 86) throw err;
      }
      try {
        await sentencesCollection.createIndex({ sentence: 1 });
      } catch (err) {
        if (err.code !== 86) throw err;
      }
    }
  } else {
    console.log(`  Warning: Sentences backup file not found`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dbName = process.env.MONGO_DB;

  if (!dbName) {
    console.error('Error: MONGO_DB environment variable not set');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('Dictionary Rollback Script');
  console.log('='.repeat(60));
  console.log(`Database: ${dbName}`);
  console.log(`Backup directory: ${BACKUP_DIR}`);
  console.log('='.repeat(60));

  // List available backups
  const backups = listBackupFiles();

  if (backups.length === 0) {
    console.error('\nError: No backup files found in', BACKUP_DIR);
    console.log('Run upload.js with --backup to create backups.');
    process.exit(1);
  }

  console.log('\nAvailable backups:');
  backups.forEach((backup, index) => {
    const parts = [];
    if (backup.words) parts.push('words');
    if (backup.sentences) parts.push('sentences');
    console.log(`  ${index + 1}. ${backup.timestamp} (${parts.join(', ')})`);
  });

  // Get timestamp from args or prompt user
  let selectedTimestamp;
  if (args.length > 0) {
    // Check if it's a number (index) or timestamp string
    const arg = args[0];
    if (/^\d+$/.test(arg)) {
      const index = parseInt(arg, 10) - 1;
      if (index >= 0 && index < backups.length) {
        selectedTimestamp = backups[index].timestamp;
      } else {
        console.error(`\nError: Invalid backup number. Please choose 1-${backups.length}`);
        process.exit(1);
      }
    } else {
      selectedTimestamp = arg;
      if (!backups.find(b => b.timestamp === selectedTimestamp)) {
        console.error(`\nError: Backup with timestamp "${selectedTimestamp}" not found`);
        process.exit(1);
      }
    }
  } else {
    console.error('\nError: Please specify a backup to restore');
    console.log('\nUsage:');
    console.log('  node scripts/rollback.js <backup-number>');
    console.log('  node scripts/rollback.js <timestamp>');
    console.log('\nExamples:');
    console.log('  node scripts/rollback.js 1');
    console.log(`  node scripts/rollback.js ${backups[0]?.timestamp || '2024-01-01_12-00-00'}`);
    process.exit(1);
  }

  console.log(`\nSelected backup: ${selectedTimestamp}`);
  console.log('\nThis will:');
  console.log('  1. Save current state to a backup file (labeled "before-rollback")');
  console.log(`  2. Restore database from backup: ${selectedTimestamp}`);
  console.log('\nPress Ctrl+C within 5 seconds to cancel...\n');
  await new Promise(resolve => setTimeout(resolve, 5000));

  const client = await MongoClient.connect(process.env.MONGO_URI);
  const db = client.db(dbName);

  try {
    // Save current state before rolling back
    await saveCurrentState(db, 'before-rollback');

    // Restore from backup
    await restoreFromBackup(db, selectedTimestamp);

    // Verify
    const wordCount = await db.collection('words').countDocuments();
    const sentenceCount = await db.collection('sentences').countDocuments();

    console.log('\n' + '='.repeat(60));
    console.log('Rollback Complete!');
    console.log('='.repeat(60));
    console.log(`Words: ${wordCount}`);
    console.log(`Sentences: ${sentenceCount}`);
    console.log(`Restored from: ${selectedTimestamp}`);
    console.log('='.repeat(60));

    await client.close();
    process.exit(0);
  } catch (error) {
    console.error('\nRollback failed:', error);
    await client.close();
    process.exit(1);
  }
}

main();
