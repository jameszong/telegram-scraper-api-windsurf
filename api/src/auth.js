import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

export class TelegramAuthService {
  constructor(env) {
    this.env = env;
    this.apiId = parseInt(env.TELEGRAM_API_ID);
    this.apiHash = env.TELEGRAM_API_HASH;
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
      const client = await this.getClient();
      await client.connect();
      
      const { phoneCodeHash } = await client.sendCode({
        apiId: this.apiId,
        apiHash: this.apiHash,
      }, phoneNumber);
      
      await client.disconnect();
      
      return {
        success: true,
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

  async verifyCode(phoneNumber, phoneCode, phoneCodeHash) {
    try {
      const client = await this.getClient();
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
        const sessionString = client.session.save();
        
        // Save session to D1
        await this.env.DB.prepare(
          'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)'
        ).bind('session_string', sessionString).run();

        await client.disconnect();

        return {
          success: true,
          sessionString,
          message: 'Authentication successful'
        };
      }
    } catch (error) {
      console.error('Auth verify error:', error);
      
      if (error.message.includes('PASSWORD_HASH')) {
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
      const sessionString = await this.getSession();
      if (!sessionString) {
        return { success: false, error: 'No session found' };
      }

      const session = new StringSession(sessionString);
      const client = await this.getClient();
      await client.connect();
      
      await client.signInWithPassword({
        apiId: this.apiId,
        apiHash: this.apiHash,
      }, {
        password,
      });

      const newSessionString = client.session.save();
      
      // Update session in D1
      await this.env.DB.prepare(
        'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)'
      ).bind('session_string', newSessionString).run();

      await client.disconnect();

      return {
        success: true,
        sessionString: newSessionString,
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
