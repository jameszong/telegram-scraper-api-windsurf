import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

export class ProcessorAuthService {
  constructor(env) {
    this.env = env;
    this.credentials = null;
  }

  // PRIORITY: Use environment variables first, fallback to D1
  async getCredentials() {
    if (this.credentials) {
      return this.credentials;
    }

    try {
      console.log('[Processor Auth] Fetching credentials...');
      
      // First try environment variables (from GitHub Actions secrets)
      if (this.env.TELEGRAM_API_ID && this.env.TELEGRAM_API_HASH) {
        console.log('[Processor Auth] Using credentials from environment variables');
        this.credentials = {
          session: this.env.TELEGRAM_SESSION || '',
          apiId: parseInt(this.env.TELEGRAM_API_ID),
          apiHash: this.env.TELEGRAM_API_HASH,
          r2PublicUrl: this.env.R2_PUBLIC_URL || ''
        };
        return this.credentials;
      }
      
      // Fallback to D1 database
      console.log('[Processor Auth] Environment variables not found, trying D1...');
      
      const sessionResult = await this.env.DB.prepare(
        'SELECT value FROM app_config WHERE key = ?'
      ).bind('TELEGRAM_SESSION').first();
      
      const apiIdResult = await this.env.DB.prepare(
        'SELECT value FROM app_config WHERE key = ?'
      ).bind('TELEGRAM_API_ID').first();
      
      const apiHashResult = await this.env.DB.prepare(
        'SELECT value FROM app_config WHERE key = ?'
      ).bind('TELEGRAM_API_HASH').first();

      const r2UrlResult = await this.env.DB.prepare(
        'SELECT value FROM app_config WHERE key = ?'
      ).bind('R2_PUBLIC_URL').first();

      if (!apiIdResult?.value || !apiHashResult?.value) {
        throw new Error('Telegram credentials not found in environment variables or D1 app_config table');
      }

      this.credentials = {
        session: sessionResult?.value || '',
        apiId: parseInt(apiIdResult.value),
        apiHash: apiHashResult.value,
        r2PublicUrl: r2UrlResult?.value || ''
      };

      console.log('[Processor Auth] Successfully loaded credentials from D1');
      return this.credentials;
    } catch (error) {
      console.error('[Processor Auth] Failed to load credentials:', error);
      throw error;
    }
  }

  async getClient() {
    const credentials = await this.getCredentials();
    const session = new StringSession(credentials.session || '');
    
    return new TelegramClient(session, credentials.apiId, credentials.apiHash, {
      connectionRetries: 5,
      retryDelay: 2000,
    });
  }

  async getR2PublicUrl() {
    const credentials = await this.getCredentials();
    return credentials.r2PublicUrl;
  }
}
