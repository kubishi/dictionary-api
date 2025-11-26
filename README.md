# Kubishi Dictionary API

Serverless API for the Kubishi Dictionary, deployed on Vercel.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required variables:
- `OPENAI_API_KEY` - Your OpenAI API key
- `MONGO_URI` - MongoDB connection string (e.g., `mongodb+srv://...`)
- `MONGO_DB` - Database name (e.g., `mnr-flex`)

### 3. Local Development

Run the development server:

```bash
npm run dev
```

This starts a local Node.js server (not Vercel CLI) at `http://localhost:3000`

Test endpoints:
```bash
# Search for "dog"
curl "http://localhost:3000/api/search?q=dog&limit=3"

# Search Paiute
curl "http://localhost:3000/api/search-paiute?q=tüka&limit=3"
```

**Note**: If you want to use Vercel's dev environment instead, run `vercel dev` directly (not through npm).

## API Endpoints

**Base URL**: `https://api.dictionary.kubishi.com`

**Documentation**: https://api.dictionary.kubishi.com/docs

### Search English (Vector Search)
```
GET /search?q=dog&limit=10
```

### Search Paiute (Exact/Partial Match)
```
GET /search-paiute?q=tüka&limit=10
```

### Search Sentences (Vector Search)
```
GET /search-sentences?q=I am hungry&limit=10
```

### Get Word by ID
```
GET /word/:id
```

**Note**: The `/api` prefix has been removed. All endpoints are now at the root level.

## Uploading Dictionary Data

To upload or update words from a LIFT file:

```bash
npm run upload <path-to-lift-file>
```

Example:
```bash
npm run upload ../kubishi_dictionary/scripts/upload/ovp_dict.lift
```

This will:
1. Parse the LIFT XML file
2. Generate OpenAI embeddings for each word/sentence
3. Upsert words and sentences to MongoDB
4. Report new/updated counts

## Deployment

### Deploy to Vercel

1. Install Vercel CLI:
```bash
npm install -g vercel
```

2. Link your project:
```bash
vercel link
```

3. Add environment variables to Vercel:
```bash
vercel env add OPENAI_API_KEY
vercel env add MONGO_URI
vercel env add MONGO_DB
```

4. Deploy:
```bash
npm run deploy
```

Your API will be live at `https://your-project.vercel.app/api/...`

## Project Structure

```
dictionary-api/
├── api/                  # Serverless functions (Vercel)
│   ├── search.js        # English vector search
│   ├── search-paiute.js # Paiute word search
│   ├── search-sentences.js
│   └── word/
│       └── [id].js      # Get word by ID
├── scripts/
│   └── upload.js        # LIFT file upload script
├── db.js                # Database & OpenAI utilities
├── vercel.json          # Vercel configuration
└── package.json
```

## MongoDB Collections

- `words` - Dictionary entries with embeddings
- `sentences` - Example sentences with embeddings
- `audios` - Audio recordings linked to words
- `metadata` - System metadata (word of the day, etc.)

## Cost Estimate

- **Vercel**: Free tier (100k requests/month)
- **MongoDB Atlas**: Free tier (M0) or $9/month
- **OpenAI**: ~$0.02 per 1000 searches
- **Total**: $0-9/month
