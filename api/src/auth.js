import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

export class TelegramAuthService {
  constructor(env) {
    this.env = env;
    this.apiId = parseInt(env.TELEGRAM_API_ID);
    this.apiHash = env.TELEGRAM_API_HASH;
    
    // Validate credentials
    if (!this.apiId || !this.apiHash) {
      throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set as environment variables');
    }
  }

  async getClient() {
    const sessionString = await this.getSession();
    const session = new StringSession(sessionString || '');
    
    return new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 5,
      retryDelay: 2000,
    });
  }

  async startAuth(phoneNumber) {
    try {
      // Create a fresh client with blank session for each request
      const session = new StringSession('');
      const client = new TelegramClient(session, this.apiId, this.apiHash, {
        connectionRetries: 5,
        retryDelay: 2000,
      });
      
      await client.connect();
      
      const { phoneCodeHash } = await client.sendCode({
        apiId: this.apiId,
        apiHash: this.apiHash,
      }, phoneNumber);
      
      // Save the session string and phoneCodeHash to return to frontend
      const sessionString = client.session.save();
      
      await client.disconnect();
      
      return {
        success: true,
        sessionString,
        phoneCodeHash,
        message: 'Code sent to your phone'
      };
    } catch (error) {
      console.error('Auth start error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async verifyCode(phoneNumber, phoneCode, phoneCodeHash, sessionString) {
    try {
      // Reconstruct the client using the session string from frontend
      const session = new StringSession(sessionString);
      const client = new TelegramClient(session, this.apiId, this.apiHash, {
        connectionRetries: 5,
        retryDelay: 2000,
      });
      
      await client.connect();
      
      // Debug logging
      console.log('Client type:', typeof client, 'Has signIn:', typeof client.signIn);
      
      const result = await client.signIn({
        apiId: this.apiId,
        apiHash: this.apiHash,
      }, {
        phoneNumber,
        phoneCode,
        phoneCodeHash,
      });

      if (result) {
        const finalSessionString = client.session.save();
        
        // Save final authenticated session to D1
        await this.env.DB.prepare(
          'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)'
        ).bind('session_string', finalSessionString).run();

        await client.disconnect();

        return {
          success: true,
          sessionString: finalSessionString,
          message: 'Authentication successful'
        };
      }
    } catch (error) {
      console.error('Auth verify error:', error);
      
      if (error.message.includes('PASSWORD_HASH')) {
        // Save the partial session for 2FA
        try {
          const partialSessionString = client.session.save();
          await this.env.DB.prepare(
            'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)'
          ).bind('partial_session_string', partialSessionString).run();
        } catch (saveError) {
          console.error('Error saving partial session:', saveError);
        }
        
        return {
          success: false,
          requires2FA: true,
          error: 'Two-factor authentication required'
        };
      }
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  async verify2FA(password) {
    try {
      const partialSessionString = await this.getPartialSession();
      if (!partialSessionString) {
        return { success: false, error: 'No partial session found' };
      }

      const session = new StringSession(partialSessionString);
      const client = new TelegramClient(session, this.apiId, this.apiHash, {
        connectionRetries: 5,
        retryDelay: 2000,
      });
      
      await client.connect();
      
      await client.signInWithPassword({
        apiId: this.apiId,
        apiHash: this.apiHash,
      }, {
        password,
      });

      const finalSessionString = client.session.save();
      
      // Update final session in D1
      await this.env.DB.prepare(
        'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)'
      ).bind('session_string', finalSessionString).run();
      
      // Clean up partial session
      await this.env.DB.prepare(
        'DELETE FROM kv_store WHERE key = ?'
      ).bind('partial_session_string').run();

      await client.disconnect();

      return {
        success: true,
        sessionString: finalSessionString,
        message: '2FA verification successful'
      };
    } catch (error) {
      console.error('2FA verify error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getPartialSession() {
    try {
      const result = await this.env.DB.prepare(
        'SELECT value FROM kv_store WHERE key = ?'
      ).bind('partial_session_string').first();
      
      return result ? result.value : null;
    } catch (error) {
      console.error('Error getting partial session:', error);
      return null;
    }
  }

  async getSession() {
    try {
      const result = await this.env.DB.prepare(
        'SELECT value FROM kv_store WHERE key = ?'
      ).bind('session_string').first();
      
      return result ? result.value : null;
    } catch (error) {
      console.error('Error getting session:', error);
      return null;
    }
  }

  async isConnected() {
    try {
      const session = await this.getSession();
      return !!session;
    } catch (error) {
      return false;
    }
  }
}
