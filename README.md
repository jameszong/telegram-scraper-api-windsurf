# Telegram Archiver

A serverless Telegram channel archiver built with Cloudflare Workers, D1, and R2.

## Features

- **Authentication**: Secure Telegram login with 2FA support
- **Channel Selection**: Browse and select channels/groups to archive
- **Message Sync**: Automatically fetch and store messages with media
- **Media Storage**: Upload photos and documents to R2 storage
- **Dark UI**: Modern dark-themed interface
- **Real-time**: Live sync status and progress tracking

## Architecture

- **Backend**: Cloudflare Workers + Hono framework
- **Frontend**: React + Vite + Tailwind CSS
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2 (Object Storage)
- **API**: gram.js for Telegram integration

## Quick Start

### Prerequisites

- Node.js 20+
- Cloudflare account with Workers, D1, and R2 enabled
- Telegram API credentials (using public Android client)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-username/telegram-scraper-api-windsurf.git
   cd telegram-scraper-api-windsurf
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure Cloudflare**
   ```bash
   # Login to Cloudflare
   npx wrangler login
   
   # Create D1 database
   npx wrangler d1 create tg-archive-db
   
   # Create R2 bucket
   npx wrangler r2 bucket create tg-archive-bucket
   ```

4. **Update wrangler.toml**
   - Replace `your-database-id-here` with your actual D1 database ID
   - Ensure bucket name matches your R2 bucket

5. **First Time Setup** ⚠️ **CRITICAL**
   ```bash
   # Apply database migrations (REQUIRED)
   npx wrangler d1 migrations apply tg-archive-db --remote
   ```

### Development

1. **Start the backend**
   ```bash
   npm run dev:api
   ```

2. **Start the frontend** (in another terminal)
   ```bash
   npm run dev:ui
   ```

3. **Access the application**
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:8787

### Deployment

The project includes GitHub Actions for automatic deployment:

1. **Set up GitHub Secrets**
   - `CLOUDFLARE_API_TOKEN`: Your Cloudflare API token
   - `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID

2. **Push to main branch**
   ```bash
   git push origin main
   ```

The workflow will:
- Deploy the backend to Cloudflare Workers
- Build and deploy the frontend to Cloudflare Pages
- Apply D1 migrations automatically

## Configuration

### Environment Variables

Public variables (in `wrangler.toml`):
- `TELEGRAM_API_ID`: 6 (public Android client)
- `TELEGRAM_API_HASH`: eb06d4abfb49dc3eeb1aeb98ae0f581e

Private variables (in `.dev.vars`):
- `DATABASE_ID`: Your D1 database ID
- `BUCKET_NAME`: Your R2 bucket name

### Database Schema

The application uses three main tables:

- `kv_store`: Session strings and configuration
- `messages`: Archived message metadata
- `media`: Media file references and metadata

## API Endpoints

### Authentication
- `POST /auth/login` - Start authentication flow
- `POST /auth/verify` - Verify authentication code
- `POST /auth/verify2fa` - Handle 2FA verification

### Channels
- `GET /channels` - List joined channels/groups
- `POST /channels/select` - Select target channel

### Sync
- `POST /sync` - Trigger message synchronization
- `GET /messages` - Retrieve archived messages (paginated)

### Media
- `GET /media/:key` - Serve media files from R2

## Usage

1. **Login**: Enter your phone number and verification code
2. **Select Channel**: Choose a channel to archive
3. **Sync**: Click "Sync Now" to fetch messages
4. **Browse**: View archived messages and media

## Security Notes

- Session strings are stored in D1 database
- R2 bucket is private (media served via backend)
- No sensitive data in frontend code
- Uses Telegram's public API credentials

## Troubleshooting

### Common Issues

1. **"No active session found"**
   - Complete the authentication process again
   - Check D1 database is properly configured

2. **"No channels found"**
   - Ensure you're logged in
   - Verify you've joined at least one channel/group

3. **"Media not found"**
   - Check R2 bucket exists and is accessible
   - Verify media was uploaded during sync

4. **Database errors**
   - Ensure migrations have been applied
   - Check D1 database ID in wrangler.toml

### Development Tips

- Use `npm run d1:migrate` to apply migrations locally
- Check `wrangler.toml` for proper configuration
- Monitor Cloudflare Workers logs for debugging

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions:
- Create an issue on GitHub
- Check the troubleshooting section
- Review Cloudflare Workers documentation
