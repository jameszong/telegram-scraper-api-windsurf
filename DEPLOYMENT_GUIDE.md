# Deployment Guide

## Overview
This guide covers the deployment of the refactored Telegram Scraper API with the new security features and stateless authentication.

## Changes Made

### 1. Backend Refactoring (Stateless Workers)
- **Auth Logic**: Refactored to be stateless - no longer relies on global client variables
- **Session Management**: Session strings are now passed between frontend and backend
- **Environment Variables**: Switched from hardcoded credentials to environment variables

### 2. Security Enhancements
- **Access Key Protection**: Added X-Access-Key header validation middleware
- **UI Gatekeeper**: Frontend access control with 32-character key validation
- **Authenticated Requests**: All API calls now include access key automatically

### 3. CI/CD Updates
- **New Secrets**: Added TELEGRAM_API_ID, TELEGRAM_API_HASH, and ACCESS_KEY to workflow
- **Environment Variables**: Properly configured for Cloudflare Workers deployment

## Required Secrets

Set these secrets in your GitHub repository and Cloudflare dashboard:

### GitHub Secrets
1. `TELEGRAM_API_ID` - Your Telegram API ID
2. `TELEGRAM_API_HASH` - Your Telegram API Hash  
3. `ACCESS_KEY` - 32-character access key for UI protection
4. `CLOUDFLARE_API_TOKEN` - Cloudflare API token (existing)
5. `CLOUDFLARE_ACCOUNT_ID` - Cloudflare account ID (existing)

### Cloudflare Worker Secrets
1. `TELEGRAM_API_ID` - Same as GitHub
2. `TELEGRAM_API_HASH` - Same as GitHub
3. `ACCESS_KEY` - Same as GitHub

## Deployment Steps

### 1. Set Up Secrets
```bash
# In GitHub repository settings > Secrets and variables > Actions
# Add the three new secrets listed above

# In Cloudflare dashboard > Workers & Pages > your-worker > Settings > Variables
# Add the same three secrets
```

### 2. Update wrangler.toml
The `wrangler.toml` has been updated to remove hardcoded credentials. The ACCESS_KEY placeholder should be replaced or set as a secret.

### 3. Deploy
```bash
# The CI/CD will automatically deploy when pushing to main branch
# For manual deployment:
npm run deploy --workspace=api
```

## Authentication Flow

### New Stateless Flow:
1. **Send Code**: `/auth/login` creates fresh client, returns sessionString + phoneCodeHash
2. **Verify Code**: `/auth/verify` receives sessionString, reconstructs client, completes auth
3. **2FA Support**: Partial sessions saved during 2FA requirement

### Access Key Flow:
1. **UI Gatekeeper**: Users must enter 32-character access key
2. **Validation**: Key validated against backend health endpoint
3. **Storage**: Key stored in localStorage, auto-added to all requests
4. **Middleware**: Backend validates X-Access-Key header on all requests

## Testing

### Local Development
1. Set environment variables in `.env` file or Cloudflare Workers dashboard
2. Generate a 32-character access key
3. Test the gatekeeper flow in the UI
4. Verify authentication works end-to-end

### Production Testing
1. Ensure all secrets are properly set
2. Test access key validation
3. Verify Telegram authentication flow
4. Check all API endpoints include access key

## Troubleshooting

### Common Issues:
- **401 Unauthorized**: Check ACCESS_KEY matches between frontend and backend
- **Missing Credentials**: Verify TELEGRAM_API_ID and TELEGRAM_API_HASH are set
- **Auth Failures**: Ensure session strings are properly passed between requests

### Debug Tips:
- Check browser localStorage for access-key-storage
- Verify Cloudflare Worker logs for authentication errors
- Test health endpoint with/without access key header

## Security Notes

- The access key provides basic UI protection
- Telegram credentials are now properly secured as secrets
- Session data is transient and not stored in global variables
- All API requests require valid access key header
