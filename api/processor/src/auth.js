import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

export class ProcessorAuthService {
  constructor(env) {
    this.env = env;
    this.credentials = null;
  }

  // CORRECT: Fetch all credentials from D1 (including dynamic Session)
  async getCredentials() {
    if (this.credentials) {
      console.log('[Processor Auth] Using cached credentials');
      return this.credentials;
    }

    try {
      console.log('[Processor Auth] Fetching credentials from D1...');
      
      // Verify DB connection first
      try {
        const dbTest = await this.env.DB.prepare('SELECT 1 as test').first();
        console.log('[Processor Auth] DB connection test:', dbTest ? 'SUCCESS' : 'FAILED');
      } catch (dbError) {
        console.error('[CRITICAL] Database connection failed:', dbError);
        throw new Error(`Database connection failed: ${dbError.message}`);
      }
      
      // Fetch session with detailed error handling
      let sessionResult;
      try {
        sessionResult = await this.env.DB.prepare(
          'SELECT value FROM app_config WHERE key = ?'
        ).bind('TELEGRAM_SESSION').first();
        console.log('[Processor Auth] Session query result:', sessionResult ? 'FOUND' : 'NOT FOUND');
      } catch (sessionError) {
        console.error('[CRITICAL] Failed to fetch session:', sessionError);
        throw new Error(`Failed to fetch TELEGRAM_SESSION: ${sessionError.message}`);
      }
      
      // Fetch API ID with detailed error handling
      let apiIdResult;
      try {
        apiIdResult = await this.env.DB.prepare(
          'SELECT value FROM app_config WHERE key = ?'
        ).bind('TELEGRAM_API_ID').first();
        console.log('[Processor Auth] API ID query result:', apiIdResult ? 'FOUND' : 'NOT FOUND');
      } catch (apiIdError) {
        console.error('[CRITICAL] Failed to fetch API ID:', apiIdError);
        throw new Error(`Failed to fetch TELEGRAM_API_ID: ${apiIdError.message}`);
      }
      
      // Fetch API Hash with detailed error handling
      let apiHashResult;
      try {
        apiHashResult = await this.env.DB.prepare(
          'SELECT value FROM app_config WHERE key = ?'
        ).bind('TELEGRAM_API_HASH').first();
        console.log('[Processor Auth] API Hash query result:', apiHashResult ? 'FOUND' : 'NOT FOUND');
      } catch (apiHashError) {
        console.error('[CRITICAL] Failed to fetch API Hash:', apiHashError);
        throw new Error(`Failed to fetch TELEGRAM_API_HASH: ${apiHashError.message}`);
      }

      // Fetch R2 URL with detailed error handling
      let r2UrlResult;
      try {
        r2UrlResult = await this.env.DB.prepare(
          'SELECT value FROM app_config WHERE key = ?'
        ).bind('R2_PUBLIC_URL').first();
        console.log('[Processor Auth] R2 URL query result:', r2UrlResult ? 'FOUND' : 'NOT FOUND');
      } catch (r2UrlError) {
        console.error('[CRITICAL] Failed to fetch R2 URL:', r2UrlError);
        throw new Error(`Failed to fetch R2_PUBLIC_URL: ${r2UrlError.message}`);
      }

      // Validate required credentials
      if (!apiIdResult?.value) {
        throw new Error('TELEGRAM_API_ID not found in D1 app_config table');
      }
      
      if (!apiHashResult?.value) {
        throw new Error('TELEGRAM_API_HASH not found in D1 app_config table');
      }
      
      if (!sessionResult?.value) {
        console.warn('[CRITICAL] TELEGRAM_SESSION not found in D1 app_config table');
      }

      // Create credentials object
      this.credentials = {
        session: sessionResult?.value || '',
        apiId: parseInt(apiIdResult.value),
        apiHash: apiHashResult.value,
        r2PublicUrl: r2UrlResult?.value || ''
      };

      console.log('[Processor Auth] Successfully loaded credentials from D1');
      console.log('[Processor Auth] Session exists:', !!this.credentials.session);
      console.log('[Processor Auth] Session length:', this.credentials.session ? this.credentials.session.length : 0);
      return this.credentials;
    } catch (error) {
      console.error('[CRITICAL] Failed to load credentials:', error);
      throw error;
    }
  }

  async getClient() {
    try {
      console.log('[Processor Auth] Getting Telegram client...');
      const credentials = await this.getCredentials();
      
      // Validate credentials before creating client
      if (!credentials.apiId) {
        throw new Error('Invalid API ID: ' + credentials.apiId);
      }
      
      if (!credentials.apiHash) {
        throw new Error('API Hash is empty');
      }
      
      // Log session info (safely)
      if (!credentials.session) {
        console.warn('[CRITICAL] Session string is empty - authentication will fail');
      } else {
        console.log('[Processor Auth] Session string length:', credentials.session.length);
        console.log('[Processor Auth] Session string starts with:', credentials.session.substring(0, 10) + '...');
      }
      
      // Create session object
      console.log('[Processor Auth] Creating StringSession...');
      const session = new StringSession(credentials.session || '');
      
      // Create client with better error handling
      console.log('[Processor Auth] Creating TelegramClient...');
      const client = new TelegramClient(session, credentials.apiId, credentials.apiHash, {
        connectionRetries: 3,
        retryDelay: 2000,
        useWSS: true, // Try WebSocket Secure connection
        maxConcurrentDownloads: 1, // Limit concurrent downloads
      });
      
      console.log('[Processor Auth] TelegramClient created successfully');
      return client;
    } catch (error) {
      console.error('[CRITICAL] Failed to create Telegram client:', error);
      throw new Error(`Failed to create Telegram client: ${error.message}`);
    }
  }

  async getR2PublicUrl() {
    const credentials = await this.getCredentials();
    return credentials.r2PublicUrl;
  }
}
