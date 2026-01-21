# Telegram Archiver API

Cloudflare Worker API for archiving Telegram channels.

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Deploy to Cloudflare Workers
npm run deploy

# Create D1 database
npm run d1:create

# Run migrations
npm run d1:migrate
```

## API Routes

### Authentication
- `POST /auth/login` - Start authentication flow
- `POST /auth/verify` - Verify authentication code

### Channels
- `GET /channels` - List joined channels
- `POST /channels/select` - Select target channel for archiving

### Sync
- `POST /sync` - Trigger message synchronization

## Environment Variables

- `TELEGRAM_API_ID` - Telegram API ID
- `TELEGRAM_API_HASH` - Telegram API Hash
- `DB` - D1 database binding
- `BUCKET` - R2 bucket binding

## Notes

- gram.js integration needs to be completed for actual Telegram API functionality
- Currently using mock data for development and testing
- D1 database and R2 bucket need to be created via Cloudflare Dashboard or Wrangler CLI
